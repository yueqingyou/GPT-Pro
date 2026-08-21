#!/usr/bin/env python3
import os
import re
import socket
import threading

LISTEN = ("0.0.0.0", 9223)
TARGET = ("127.0.0.1", 9222)
HOST_RE = re.compile(rb"(?im)^host:\s*[^\r\n]+")
ALLOWED_NAMES = tuple(
    name.strip() for name in os.environ["GPC_CDP_ALLOW"].split(",") if name.strip()
)
if not ALLOWED_NAMES:
    raise RuntimeError("GPC_CDP_ALLOW 不能为空")


def peer_ip(addr):
    ip = addr[0] if addr else ""
    if ip.startswith("::ffff:"):
        return ip[7:]
    return ip


def allowed(peer):
    ips = set()
    for name in ALLOWED_NAMES:
        try:
            for item in socket.getaddrinfo(name, None):
                ips.add(item[4][0])
        except OSError:
            continue
    return peer in ips


def rewrite_host(data: bytes) -> bytes:
    if not (
        data.startswith(b"GET ")
        or data.startswith(b"POST ")
        or data.startswith(b"HEAD ")
    ):
        return data
    return HOST_RE.sub(b"Host: 127.0.0.1:9222", data, count=1)


def read_request(client) -> bytes:
    data = bytearray()
    while b"\r\n\r\n" not in data:
        chunk = client.recv(65536 - len(data))
        if not chunk:
            return b""
        data.extend(chunk)
        if len(data) == 65536 and b"\r\n\r\n" not in data:
            raise OSError("HTTP 请求头过大")
    return rewrite_host(bytes(data))


def pipe(src, dst, first=None):
    try:
        if first:
            dst.sendall(first)
        while True:
            chunk = src.recv(65536)
            if not chunk:
                break
            dst.sendall(chunk)
    except OSError:
        pass
    finally:
        for s in (src, dst):
            try:
                s.close()
            except OSError:
                pass


def handle(client):
    try:
        remote = socket.create_connection(TARGET, timeout=5)
        remote.settimeout(None)
    except OSError:
        client.close()
        return
    try:
        first = read_request(client)
    except OSError:
        client.close()
        remote.close()
        return
    if not first:
        client.close()
        remote.close()
        return
    threading.Thread(target=pipe, args=(client, remote, first), daemon=True).start()
    pipe(remote, client)


def main():
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(LISTEN)
    srv.listen(16)
    while True:
        client, addr = srv.accept()
        if not allowed(peer_ip(addr)):
            try:
                client.close()
            except OSError:
                pass
            continue
        threading.Thread(target=handle, args=(client,), daemon=True).start()


if __name__ == "__main__":
    main()
