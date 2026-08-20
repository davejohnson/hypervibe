package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/coder/websocket"
	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

type helperConfig struct {
	LocalPrivateKey string `json:"localPrivateKey"`
	PeerIP          string `json:"peerIp"`
	EndpointIP      string `json:"endpointIp"`
	RemotePublicKey string `json:"remotePublicKey"`
	RemoteHost      string `json:"remoteHost"`
	RemotePort      int    `json:"remotePort"`
}

type readyMessage struct {
	Status string `json:"status"`
	Port   int    `json:"port"`
}

type tunnel struct {
	device   *device.Device
	tun      tun.Device
	netstack *netstack.Net
	dnsIP    netip.Addr
	remote   netip.Prefix
	ws       *websocketWireGuard
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "fly wireguard connector failed")
		os.Exit(1)
	}
}

func run() error {
	decoder := json.NewDecoder(io.LimitReader(os.Stdin, 64*1024))
	decoder.DisallowUnknownFields()
	var cfg helperConfig
	if err := decoder.Decode(&cfg); err != nil {
		return fmt.Errorf("decode connector configuration: %w", err)
	}
	if err := validateConfig(cfg); err != nil {
		return err
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	go func() {
		_, _ = io.Copy(io.Discard, os.Stdin)
		cancel()
	}()

	tun, err := connectTunnel(ctx, cfg)
	if err != nil {
		return err
	}
	defer tun.close()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("listen locally: %w", err)
	}
	defer listener.Close()
	port := listener.Addr().(*net.TCPAddr).Port
	if err := json.NewEncoder(os.Stdout).Encode(readyMessage{Status: "ready", Port: port}); err != nil {
		return fmt.Errorf("report readiness: %w", err)
	}

	go func() {
		<-ctx.Done()
		_ = listener.Close()
	}()
	for {
		local, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return nil
			}
			return fmt.Errorf("accept local connection: %w", err)
		}
		go proxyConnection(ctx, tun, cfg, local)
	}
}

func validateConfig(cfg helperConfig) error {
	privateKey, privateErr := base64.StdEncoding.DecodeString(cfg.LocalPrivateKey)
	publicKey, publicErr := base64.StdEncoding.DecodeString(cfg.RemotePublicKey)
	if privateErr != nil || len(privateKey) != 32 {
		return errors.New("local WireGuard private key is invalid")
	}
	if publicErr != nil || len(publicKey) != 32 {
		return errors.New("remote WireGuard public key is invalid")
	}
	if _, err := netip.ParseAddr(cfg.PeerIP); err != nil {
		return errors.New("WireGuard peer address is invalid")
	}
	if net.ParseIP(cfg.EndpointIP) == nil && !validHostname(cfg.EndpointIP) {
		return errors.New("WireGuard endpoint is invalid")
	}
	if net.ParseIP(cfg.RemoteHost) == nil && !validHostname(cfg.RemoteHost) {
		return errors.New("database endpoint is invalid")
	}
	if cfg.RemotePort < 1 || cfg.RemotePort > 65535 {
		return errors.New("database endpoint port is invalid")
	}
	return nil
}

func validHostname(value string) bool {
	if len(value) < 1 || len(value) > 253 || strings.ContainsAny(value, " /\\\t\r\n") {
		return false
	}
	for _, label := range strings.Split(value, ".") {
		if len(label) < 1 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, char := range label {
			if (char < 'a' || char > 'z') && (char < 'A' || char > 'Z') &&
				(char < '0' || char > '9') && char != '-' {
				return false
			}
		}
	}
	return true
}

func connectTunnel(ctx context.Context, cfg helperConfig) (*tunnel, error) {
	peerIP, _ := netip.ParseAddr(cfg.PeerIP)
	localIP, dnsIP, remoteNetwork, err := flyNetwork(peerIP)
	if err != nil {
		return nil, err
	}

	tunDevice, tunnelNet, err := netstack.CreateNetTUN(
		[]netip.Addr{localIP},
		[]netip.Addr{dnsIP},
		1280,
	)
	if err != nil {
		return nil, fmt.Errorf("create userspace network: %w", err)
	}
	ws, err := startWebsocketWireGuard(ctx, cfg.EndpointIP)
	if err != nil {
		tunDevice.Close()
		return nil, err
	}

	privateKey, _ := base64.StdEncoding.DecodeString(cfg.LocalPrivateKey)
	publicKey, _ := base64.StdEncoding.DecodeString(cfg.RemotePublicKey)
	wgDevice := device.NewDevice(
		tunDevice,
		conn.NewDefaultBind(),
		device.NewLogger(device.LogLevelError, "(hypervibe-fly-wireguard) "),
	)
	configuration := bytes.NewBuffer(nil)
	fmt.Fprintf(configuration, "private_key=%s\n", hex.EncodeToString(privateKey))
	fmt.Fprintf(configuration, "public_key=%s\n", hex.EncodeToString(publicKey))
	fmt.Fprintf(configuration, "endpoint=%s\n", net.JoinHostPort("127.0.0.1", fmt.Sprint(ws.port())))
	fmt.Fprintf(configuration, "allowed_ip=%s\n", remoteNetwork.String())
	fmt.Fprintln(configuration, "persistent_keepalive_interval=25")
	if err := wgDevice.IpcSetOperation(bufio.NewReader(configuration)); err != nil {
		wgDevice.Close()
		ws.close()
		return nil, fmt.Errorf("configure WireGuard: %w", err)
	}
	if err := wgDevice.Up(); err != nil {
		wgDevice.Close()
		ws.close()
		return nil, fmt.Errorf("start WireGuard: %w", err)
	}
	return &tunnel{
		device:   wgDevice,
		tun:      tunDevice,
		netstack: tunnelNet,
		dnsIP:    dnsIP,
		remote:   remoteNetwork,
		ws:       ws,
	}, nil
}

func flyNetwork(peerIP netip.Addr) (netip.Addr, netip.Addr, netip.Prefix, error) {
	if !peerIP.Is6() {
		return netip.Addr{}, netip.Addr{}, netip.Prefix{}, errors.New("Fly.io WireGuard peer did not return an IPv6 address")
	}
	peerBytes := peerIP.As16()
	peerBytes[15] = 0
	localIP := netip.AddrFrom16(peerBytes)
	for index := 6; index < len(peerBytes); index++ {
		peerBytes[index] = 0
	}
	remoteNetwork := netip.PrefixFrom(netip.AddrFrom16(peerBytes), 48)
	peerBytes[15] = 3
	dnsIP := netip.AddrFrom16(peerBytes)
	return localIP, dnsIP, remoteNetwork, nil
}

func (t *tunnel) close() {
	if t.device != nil {
		t.device.Close()
	}
	if t.tun != nil {
		t.tun.Close()
	}
	if t.ws != nil {
		t.ws.close()
	}
}

func proxyConnection(ctx context.Context, tun *tunnel, cfg helperConfig, local net.Conn) {
	defer local.Close()
	remoteAddress, err := tun.resolve(ctx, cfg.RemoteHost, cfg.RemotePort)
	if err != nil {
		return
	}
	remote, err := tun.netstack.DialContext(ctx, "tcp", remoteAddress)
	if err != nil {
		return
	}
	defer remote.Close()

	done := make(chan struct{}, 2)
	copyStream := func(dst net.Conn, src net.Conn) {
		_, _ = io.Copy(dst, src)
		if tcp, ok := dst.(*net.TCPConn); ok {
			_ = tcp.CloseWrite()
		}
		done <- struct{}{}
	}
	go copyStream(remote, local)
	go copyStream(local, remote)
	select {
	case <-ctx.Done():
	case <-done:
	}
}

func (t *tunnel) resolve(ctx context.Context, host string, port int) (string, error) {
	if address, err := netip.ParseAddr(host); err == nil {
		if !t.remote.Contains(address) {
			return "", errors.New("database endpoint resolved outside the Fly.io organization network")
		}
		return net.JoinHostPort(address.String(), fmt.Sprint(port)), nil
	}
	resolver := &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return t.netstack.DialContext(ctx, "tcp", net.JoinHostPort(t.dnsIP.String(), "53"))
		},
	}
	addresses, err := resolver.LookupIPAddr(ctx, host)
	if err != nil {
		return "", fmt.Errorf("resolve database endpoint: %w", err)
	}
	for _, candidate := range addresses {
		address, ok := netip.AddrFromSlice(candidate.IP)
		if ok && t.remote.Contains(address) {
			return net.JoinHostPort(address.String(), fmt.Sprint(port)), nil
		}
	}
	return "", errors.New("database endpoint did not resolve inside the Fly.io organization network")
}

type websocketWireGuard struct {
	cancel context.CancelFunc
	udp    *net.UDPConn
	ws     net.Conn
	mu     sync.Mutex
	last   net.Addr
	lastIO time.Time
}

func startWebsocketWireGuard(parent context.Context, endpoint string) (*websocketWireGuard, error) {
	ctx, cancel := context.WithCancel(parent)
	udp, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1")})
	if err != nil {
		cancel()
		return nil, fmt.Errorf("start WireGuard websocket bridge: %w", err)
	}
	host := net.JoinHostPort(endpoint, "443")
	if net.ParseIP(endpoint) == nil {
		host = endpoint + ":443"
	}
	websocketURL := (&url.URL{Scheme: "wss", Host: host, Path: "/"}).String()
	connection, _, err := websocket.Dial(ctx, websocketURL, &websocket.DialOptions{
		HTTPClient: &http.Client{Transport: &http.Transport{
			Proxy: http.ProxyFromEnvironment,
			TLSClientConfig: &tls.Config{ // The WireGuard payload remains authenticated and encrypted.
				InsecureSkipVerify: true, //nolint:gosec
			},
		}},
		HTTPHeader: http.Header{"Origin": []string{websocketURL}},
	})
	if err != nil {
		udp.Close()
		cancel()
		return nil, fmt.Errorf("connect Fly.io WireGuard websocket: %w", err)
	}
	stream := websocket.NetConn(ctx, connection, websocket.MessageText)
	var magic [4]byte
	binary.BigEndian.PutUint32(magic[:], 0x2FACED77)
	if _, err := stream.Write(magic[:]); err != nil {
		stream.Close()
		udp.Close()
		cancel()
		return nil, fmt.Errorf("initialize Fly.io WireGuard websocket: %w", err)
	}
	bridge := &websocketWireGuard{
		cancel: cancel,
		udp:    udp,
		ws:     stream,
		lastIO: time.Now(),
	}
	go bridge.websocketToWireGuard(ctx)
	go bridge.wireGuardToWebsocket(ctx)
	go bridge.keepalive(ctx)
	return bridge, nil
}

func (bridge *websocketWireGuard) port() int {
	return bridge.udp.LocalAddr().(*net.UDPAddr).Port
}

func (bridge *websocketWireGuard) close() {
	bridge.cancel()
	_ = bridge.ws.Close()
	_ = bridge.udp.Close()
}

func (bridge *websocketWireGuard) websocketToWireGuard(ctx context.Context) {
	buffer := make([]byte, 64*1024)
	for ctx.Err() == nil {
		var lengthBytes [4]byte
		if _, err := io.ReadFull(bridge.ws, lengthBytes[:]); err != nil {
			bridge.cancel()
			return
		}
		length := int(binary.BigEndian.Uint32(lengthBytes[:]))
		if length > len(buffer) {
			bridge.cancel()
			return
		}
		if length == 0 {
			bridge.touch()
			continue
		}
		if _, err := io.ReadFull(bridge.ws, buffer[:length]); err != nil {
			bridge.cancel()
			return
		}
		bridge.mu.Lock()
		destination := bridge.last
		bridge.lastIO = time.Now()
		bridge.mu.Unlock()
		if destination == nil {
			continue
		}
		if _, err := bridge.udp.WriteTo(buffer[:length], destination); err != nil {
			bridge.cancel()
			return
		}
	}
}

func (bridge *websocketWireGuard) wireGuardToWebsocket(ctx context.Context) {
	buffer := make([]byte, 64*1024+4)
	for ctx.Err() == nil {
		_ = bridge.udp.SetReadDeadline(time.Now().Add(time.Second))
		length, source, err := bridge.udp.ReadFrom(buffer[4:])
		if err != nil {
			if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
				continue
			}
			bridge.cancel()
			return
		}
		binary.BigEndian.PutUint32(buffer[:4], uint32(length))
		bridge.mu.Lock()
		bridge.last = source
		bridge.lastIO = time.Now()
		_, err = bridge.ws.Write(buffer[:length+4])
		bridge.mu.Unlock()
		if err != nil {
			bridge.cancel()
			return
		}
	}
}

func (bridge *websocketWireGuard) touch() {
	bridge.mu.Lock()
	bridge.lastIO = time.Now()
	bridge.mu.Unlock()
}

func (bridge *websocketWireGuard) keepalive(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	zeroLengthFrame := make([]byte, 4)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			bridge.mu.Lock()
			if time.Since(bridge.lastIO) <= time.Second {
				bridge.mu.Unlock()
				continue
			}
			_, err := bridge.ws.Write(zeroLengthFrame)
			if err == nil {
				bridge.lastIO = time.Now()
			}
			bridge.mu.Unlock()
			if err != nil {
				bridge.cancel()
				return
			}
		}
	}
}
