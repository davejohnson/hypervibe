package main

import (
	"encoding/base64"
	"net/netip"
	"testing"
)

func TestValidateConfig(t *testing.T) {
	key := base64.StdEncoding.EncodeToString(make([]byte, 32))
	valid := helperConfig{
		LocalPrivateKey: key,
		PeerIP:          "fdaa:1:2:a7b:1234:5678:9abc:deff",
		EndpointIP:      "wireguard.example.com",
		RemotePublicKey: key,
		RemoteHost:      "cluster.internal",
		RemotePort:      5432,
	}
	if err := validateConfig(valid); err != nil {
		t.Fatalf("expected valid configuration: %v", err)
	}
	invalid := valid
	invalid.RemoteHost = "cluster.internal/path"
	if err := validateConfig(invalid); err == nil {
		t.Fatal("expected invalid database host to be rejected")
	}
}

func TestFlyNetworkMatchesFlyOrganizationAddressing(t *testing.T) {
	peer := netip.MustParseAddr("fdaa:1:2:a7b:1234:5678:9abc:deff")
	local, dns, remote, err := flyNetwork(peer)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := local.String(), "fdaa:1:2:a7b:1234:5678:9abc:de00"; got != want {
		t.Fatalf("local address = %s, want %s", got, want)
	}
	if got, want := dns.String(), "fdaa:1:2::3"; got != want {
		t.Fatalf("DNS address = %s, want %s", got, want)
	}
	if got, want := remote.String(), "fdaa:1:2::/48"; got != want {
		t.Fatalf("organization network = %s, want %s", got, want)
	}
}

func TestFlyNetworkRejectsIPv4(t *testing.T) {
	if _, _, _, err := flyNetwork(netip.MustParseAddr("127.0.0.1")); err == nil {
		t.Fatal("expected IPv4 peer address to be rejected")
	}
}
