#!/usr/bin/env python3
"""Send one native-messaging request to the host and print the reply.

Usage: nm_client.py <host-path> '<json request>'
"""
import json
import struct
import subprocess
import sys


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    host, payload = sys.argv[1], sys.argv[2]
    body = json.dumps(json.loads(payload), ensure_ascii=False).encode("utf-8")
    proc = subprocess.run([host], input=struct.pack("@I", len(body)) + body,
                          capture_output=True, timeout=int(sys.argv[3]) if len(sys.argv) > 3 else 300)
    raw = proc.stdout
    if len(raw) < 4:
        print("NO RESPONSE")
        print("stderr:", proc.stderr.decode("utf-8", "replace")[:500])
        return 1
    (length,) = struct.unpack("@I", raw[:4])
    reply = raw[4:4 + length].decode("utf-8")
    print(json.dumps(json.loads(reply), ensure_ascii=False, indent=2))
    if proc.stderr:
        print("--- stderr ---")
        print(proc.stderr.decode("utf-8", "replace")[:500])
    return 0


if __name__ == "__main__":
    sys.exit(main())
