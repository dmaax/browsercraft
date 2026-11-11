"""Minimal Minecraft protocol probe: status ping + offline-mode login.

usage: mcping.py HOST PORT [NAME]
       mcping.py --ws ws://HOST:PORT/ws MCHOST MCPORT [NAME]   (through the browsercraft bridge)
"""
import json, socket, struct, sys, uuid, zlib, base64, os


def varint(n):
    out = b''
    n &= 0xFFFFFFFF
    while True:
        b = n & 0x7F
        n >>= 7
        out += bytes([b | (0x80 if n else 0)])
        if not n:
            return out


def mcstr(s):
    b = s.encode()
    return varint(len(b)) + b


class Raw:
    def __init__(self, host, port):
        self.s = socket.create_connection((host, port), timeout=10)
        self.buf = b''

    def send(self, b): self.s.sendall(b)

    def recv(self, n):
        while len(self.buf) < n:
            d = self.s.recv(65536)
            if not d:
                raise EOFError('connection closed')
            self.buf += d
        r, self.buf = self.buf[:n], self.buf[n:]
        return r


class Ws(Raw):
    """Just enough of RFC 6455 (client side, binary frames) to talk through the bridge."""

    def __init__(self, url, cookie=None):
        assert url.startswith('ws://')
        hp, path = url[5:].split('/', 1)
        h, p = hp.split(':')
        self.s = socket.create_connection((h, int(p)), timeout=10)
        self.buf = b''
        self.inbuf = b''
        key = base64.b64encode(os.urandom(16)).decode()
        req = f'GET /{path} HTTP/1.1\r\nHost: {hp}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nOrigin: http://{hp}\r\n'
        if cookie:
            req += f'Cookie: {cookie}\r\n'
        self.s.sendall((req + '\r\n').encode())
        resp = b''
        while b'\r\n\r\n' not in resp:
            d = self.s.recv(4096)
            if not d:
                raise EOFError('bridge closed the handshake')
            resp += d
        head, self.inbuf = resp.split(b'\r\n\r\n', 1)
        if b' 101 ' not in head.split(b'\r\n')[0]:
            raise EOFError('bridge refused: ' + head.split(b'\r\n')[0].decode())

    def send(self, b):
        mask = os.urandom(4)
        n = len(b)
        hdr = bytes([0x82]) + (bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + struct.pack('>H', n) if n < 65536 else bytes([0x80 | 127]) + struct.pack('>Q', n))
        self.s.sendall(hdr + mask + bytes(c ^ mask[i % 4] for i, c in enumerate(b)))

    def _raw(self, n):
        while len(self.inbuf) < n:
            d = self.s.recv(65536)
            if not d:
                raise EOFError('connection closed')
            self.inbuf += d
        r, self.inbuf = self.inbuf[:n], self.inbuf[n:]
        return r

    def recv(self, n):
        while len(self.buf) < n:
            b0, b1 = self._raw(2)
            ln = b1 & 0x7F
            if ln == 126: ln = struct.unpack('>H', self._raw(2))[0]
            elif ln == 127: ln = struct.unpack('>Q', self._raw(8))[0]
            payload = self._raw(ln)
            op = b0 & 0x0F
            if op == 8:
                raise EOFError('bridge closed the websocket')
            if op in (0, 1, 2):
                self.buf += payload
        r, self.buf = self.buf[:n], self.buf[n:]
        return r


class Conn:
    def __init__(self, t):
        self.t = t
        self.threshold = -1

    def rvarint(self):
        n = sh = 0
        while True:
            b = self.t.recv(1)[0]
            n |= (b & 0x7F) << sh
            sh += 7
            if not b & 0x80:
                return n

    def send(self, pid, data=b''):
        body = varint(pid) + data
        if self.threshold >= 0:
            body = varint(0) + body  # below threshold: uncompressed
        self.t.send(varint(len(body)) + body)

    def read(self):
        ln = self.rvarint()
        data = self.t.recv(ln)
        if self.threshold >= 0:
            i, dl = 0, 0
            sh = 0
            while True:
                b = data[i]; i += 1
                dl |= (b & 0x7F) << sh; sh += 7
                if not b & 0x80: break
            data = zlib.decompress(data[i:]) if dl else data[i:]
        i, pid, sh = 0, 0, 0
        while True:
            b = data[i]; i += 1
            pid |= (b & 0x7F) << sh; sh += 7
            if not b & 0x80: break
        return pid, data[i:]


def handshake(c, host, port, proto, nxt):
    c.send(0x00, varint(proto) + mcstr(host) + struct.pack('>H', port) + varint(nxt))


def readstr(d):
    n = sh = i = 0
    while True:
        b = d[i]; i += 1
        n |= (b & 0x7F) << sh; sh += 7
        if not b & 0x80: break
    return d[i:i + n].decode(), d[i + n:]


def main():
    a = sys.argv[1:]
    mk = None
    if a[0] == '--ws':
        url, host, port = a[1], a[2], int(a[3])
        rest = a[4:]
        mk = lambda: Ws(f'{url}?h={host}&p={port}')
    else:
        host, port = a[0], int(a[1])
        rest = a[2:]
        mk = lambda: Raw(host, port)
    name = rest[0] if rest else 'BcProbe'

    c = Conn(mk())
    handshake(c, host, port, 0, 1)
    c.send(0x00)
    pid, d = c.read()
    st = json.loads(readstr(d)[0])
    proto = st['version']['protocol']
    print(f"STATUS ok: version={st['version']['name']} protocol={proto} players={st['players']['online']}/{st['players']['max']} motd={json.dumps(st.get('description'))[:60]}")

    c = Conn(mk())
    handshake(c, host, port, proto, 2)
    c.send(0x00, mcstr(name) + uuid.uuid3(uuid.NAMESPACE_DNS, name).bytes)
    while True:
        pid, d = c.read()
        if pid == 0x03:  # Set Compression
            n = sh = i = 0
            while True:
                b = d[i]; i += 1
                n |= (b & 0x7F) << sh; sh += 7
                if not b & 0x80: break
            c.threshold = n
            print(f'  set compression threshold={n}')
        elif pid == 0x01:
            print('LOGIN FAILED: server asked for encryption -> online-mode is ON')
            sys.exit(2)
        elif pid == 0x00:
            print('LOGIN REJECTED: ' + readstr(d)[0])
            sys.exit(2)
        elif pid == 0x02:
            u = uuid.UUID(bytes=d[:16])
            nm, _ = readstr(d[16:])
            print(f'LOGIN ok (offline): name={nm} uuid={u}')
            c.send(0x03)  # Login Acknowledged -> configuration state
            pid, d = c.read()
            print(f'  configuration state reached, first packet id=0x{pid:02x} ({len(d)} bytes)')
            return
        else:
            print(f'  login packet 0x{pid:02x} ignored')


main()
