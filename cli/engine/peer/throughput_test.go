package peer_test

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jannskiee/floe/cli/engine/transfer"
)

// BenchmarkLoopbackTransfer measures throughput between two Floe peers paired
// through peer.New. From cli/, run:
//
//	go test -run '^$' -bench '^BenchmarkLoopbackTransfer$' -benchtime 5x -count 6 -timeout 30m ./engine/peer/
func BenchmarkLoopbackTransfer(b *testing.B) {
	b.StopTimer()
	stdout := os.Stdout
	devNull, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		b.Fatalf("open os.DevNull: %v", err)
	}
	os.Stdout = devNull
	b.Cleanup(func() {
		os.Stdout = stdout
		if err := devNull.Close(); err != nil {
			b.Errorf("close os.DevNull: %v", err)
		}
	})

	b.Run("one-64MiB", func(b *testing.B) {
		b.StopTimer()
		srcDir := b.TempDir()
		name := "one-64MiB.bin"
		srcPath := filepath.Join(srcDir, name)
		want := map[string][sha256.Size]byte{
			name: writeRandom(b, srcDir, name, 64<<20),
		}
		benchmarkLoopbackTransfer(b, []string{srcPath}, want)
	})

	b.Run("256x256KiB", func(b *testing.B) {
		b.StopTimer()
		srcDir := b.TempDir()
		payloadDir := filepath.Join(srcDir, "payload")
		if err := os.Mkdir(payloadDir, 0o755); err != nil {
			b.Fatalf("make payload directory: %v", err)
		}
		want := make(map[string][sha256.Size]byte, 256)
		for i := 0; i < 256; i++ {
			name := fmt.Sprintf("file-%03d.bin", i)
			want["payload/"+name] = writeRandom(b, payloadDir, name, 256<<10)
		}
		benchmarkLoopbackTransfer(b, []string{payloadDir}, want)
	})
}

func benchmarkLoopbackTransfer(b *testing.B, paths []string, want map[string][sha256.Size]byte) {
	b.Helper()
	b.SetBytes(64 << 20)
	relayURL := newRelay(b)
	b.ResetTimer()

	for i := 0; i < b.N; i++ {
		b.StopTimer()
		host, visitor := pairHostVisitor(b, relayURL)
		outDir := b.TempDir()
		receiveErr := make(chan error, 1)
		go func() {
			receiveErr <- transfer.ReceiveFilesWithOptions(visitor.dc, outDir, true, "", "", transfer.ReceiveOptions{
				OnProgress: func(transfer.Progress) {},
				Messages:   visitor.early.Msgs,
				Closed:     visitor.early.Closed,
			})
		}()

		b.StartTimer()
		sendErr := transfer.SendFilesWithOptions(host.dc, paths, "", transfer.SendOptions{
			OnProgress: func(transfer.Progress) {},
			Messages:   host.early.Msgs,
			Closed:     host.early.Closed,
			NoSummary:  true,
		})
		b.StopTimer()

		host.close()
		var recvErr error
		select {
		case recvErr = <-receiveErr:
		case <-time.After(60 * time.Second):
			visitor.close()
			b.Fatalf("visitor ReceiveFilesWithOptions did not return within 60s")
		}
		visitor.close()
		if sendErr != nil {
			b.Fatalf("host SendFilesWithOptions: %v", sendErr)
		}
		if recvErr != nil {
			b.Fatalf("visitor ReceiveFilesWithOptions: %v", recvErr)
		}
		checkTree(b, outDir, want)
	}
}
