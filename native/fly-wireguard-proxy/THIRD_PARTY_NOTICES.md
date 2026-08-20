# Fly WireGuard helper third-party notices

This helper links the upstream WireGuard Go userspace implementation and its
userspace network stack (`golang.zx2c4.com/wireguard`), plus the Coder WebSocket
library (`github.com/coder/websocket`) and their transitive Go modules. The
published helper directory includes the license text for every module in
`go.mod`; exact module versions and checksums are recorded in `go.mod` and
`go.sum` in the source distribution.

The Fly.io peer and WebSocket protocols are implemented from Fly.io's published
Apache-2.0 `flyctl` and `fly-go` sources. Hypervibe's implementation is separate
and does not execute or distribute the Fly CLI.
