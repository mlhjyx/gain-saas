import sys
import dkim

raw = open(sys.argv[1], "rb").read()
public_key = open(sys.argv[2]).read().strip()

queries = []

def dnsfunc(name, timeout=5):
    queries.append(name.decode() if isinstance(name, bytes) else str(name))
    return ("v=DKIM1; k=rsa; p=" + public_key).encode()

ok = dkim.verify(raw, dnsfunc=dnsfunc)
print("dkim_verify:", "PASS" if ok else "FAIL")
print("dns_queries:", queries)
sys.exit(0 if ok else 1)
