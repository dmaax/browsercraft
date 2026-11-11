import http.server, os, posixpath, re, sys, urllib.parse, urllib.request, threading

ROOT = os.path.abspath(sys.argv[1])
DATA = os.path.abspath(sys.argv[2])
PORT = int(sys.argv[3]) if len(sys.argv) > 3 else 8090
BIND = sys.argv[4] if len(sys.argv) > 4 else '127.0.0.1'
OBJ = re.compile(r'^[0-9a-f]{2}/[0-9a-f]{40}$')
lock = threading.Lock()


def safe(base, rel):
    rel = posixpath.normpath('/' + rel).lstrip('/')
    p = os.path.normpath(os.path.join(base, *rel.split('/'))) if rel else base
    return p if p == base or p.startswith(base + os.sep) else None


class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def translate_path(self, path):
        path = urllib.parse.unquote(path.split('?', 1)[0].split('#', 1)[0])
        if path.startswith('/data/'):
            rel = path[6:]
            if rel.startswith('assets/objects/'):
                h = rel[len('assets/objects/'):]
                if not OBJ.match(h):
                    return ''
                p = os.path.join(DATA, 'assets', 'objects', *h.split('/'))
                if not os.path.exists(p):
                    with lock:
                        if not os.path.exists(p):
                            os.makedirs(os.path.dirname(p), exist_ok=True)
                            try:
                                urllib.request.urlretrieve('https://resources.download.minecraft.net/' + h, p + '.tmp')
                                os.replace(p + '.tmp', p)
                            except Exception:
                                try: os.remove(p + '.tmp')
                                except OSError: pass
                return p
            return safe(DATA, rel) or ''
        return safe(ROOT, path) or ''

    def log_message(self, *a):
        pass


H.extensions_map.update({'.wasm': 'application/wasm', '.js': 'text/javascript', '.mjs': 'text/javascript'})
http.server.ThreadingHTTPServer((BIND, PORT), H).serve_forever()
