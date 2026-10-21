"""Evidence toku dílů: server (api.php, api/v1, router) a nástroje v bin/.

python3 -m unittest discover -s tests
"""

from http.cookiejar import CookieJar
from pathlib import Path
import json
import os
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request

APP = Path(__file__).resolve().parents[1]
PHP = shutil.which("php")
PASSWORD = "tajneheslo1"


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Server:
    def __init__(self, data=None):
        self.data = Path(data) if data else Path(tempfile.mkdtemp(prefix="etd-"))
        self.port = free_port()
        self.base = f"http://127.0.0.1:{self.port}"
        self.env = dict(os.environ, ETD_DATA_DIR=str(self.data), NO_PROXY="*")
        self.process = subprocess.Popen(
            [PHP, "-S", f"127.0.0.1:{self.port}", "router.php"],
            cwd=APP, env=self.env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        for _ in range(100):
            try:
                with socket.create_connection(("127.0.0.1", self.port), timeout=0.2):
                    return
            except OSError:
                time.sleep(0.05)
        raise RuntimeError("PHP server se nespustil")

    def stop(self):
        self.process.terminate()
        self.process.wait(timeout=5)

    def cli(self, *args):
        return subprocess.run([PHP, *args], cwd=APP, env=self.env, capture_output=True, text=True, timeout=30)

    def db(self):
        return sqlite3.connect(self.data / "evidence.sqlite3")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Client:
    """Prohlížeč: cookie relace a hlavičky, které posílá static/app.js."""

    def __init__(self, server):
        self.server = server
        self.jar = CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(), urllib.request.HTTPCookieProcessor(self.jar))

    def request(self, method, path, body=None, headers=None, raw=False):
        data = None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
        h = {"X-Etd": "1", "X-Etd-Client": "1"}
        if body is not None:
            h["Content-Type"] = "application/json"
        h.update(headers or {})
        h = {k: v for k, v in h.items() if v is not None}
        req = urllib.request.Request(self.server.base + path, data=data, method=method, headers=h)
        try:
            with self.opener.open(req, timeout=15) as res:
                payload = res.read()
                status, hdrs = res.status, res.headers
        except urllib.error.HTTPError as err:
            payload = err.read()
            status, hdrs = err.code, err.headers
        if raw:
            return status, payload, hdrs
        try:
            return status, json.loads(payload or b"null")
        except ValueError:
            return status, payload.decode("utf-8", "replace")

    def get(self, action, **query):
        qs = urllib.parse.urlencode({"action": action, **query})
        return self.request("GET", f"/api.php?{qs}")

    def post(self, action, body=None, **kw):
        return self.request("POST", f"/api.php?action={action}", body if body is not None else {}, **kw)

    def login(self, login, password=PASSWORD):
        status, data = self.post("login", {"login": login, "password": password})
        assert status == 200, (status, data)
        return data

    def dept(self, code):
        status, data = self.post("dept", {"dept": code})
        assert status == 200, (status, data)
        return data

    def scan(self, action, items, position="", force=False, define=None):
        body = {"action": action, "items": items, "position": position, "force": force}
        if define is not None:
            body["definePosition"] = define
        return self.post("scan", body)



class Base(unittest.TestCase):
    """Každý test má vlastní server s čistými daty a prvního správce."""

    def setUp(self):
        self.server = Server()
        self.admin = Client(self.server)
        token = self.server.cli("bin/setup-token.php").stdout.strip()
        status, data = self.admin.post("setup", {"token": token, "login": "spravce", "name": "Jana Správcová", "password": PASSWORD})
        self.assertEqual(status, 200, data)

    def tearDown(self):
        self.server.stop()
        shutil.rmtree(self.server.data, ignore_errors=True)

    def user(self, login, role="operator", depts=None, must_change=False, name=None):
        status, data = self.admin.post("user_save", {"login": login, "name": name or login.title(), "role": role, "depts": depts or [],
                                                     "password": PASSWORD, "mustChange": must_change, "active": True})
        self.assertEqual(status, 200, data)
        client = Client(self.server)
        client.login(login)
        return client, data["user"]


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.server = Server()
        self.client = Client(self.server)

    def tearDown(self):
        self.server.stop()
        shutil.rmtree(self.server.data, ignore_errors=True)

    def test_first_admin_needs_setup_code_from_server(self):
        status, state = self.client.get("state")
        self.assertEqual(status, 200)
        self.assertTrue(state["setup"])
        self.assertEqual([d["code"] for d in state["depts"]], ["brouseni_wpa", "brush_wpa", "hala", "montaz", "elox", "studio", "cnc_hala2"])
        token = self.server.cli("bin/setup-token.php").stdout.strip()
        self.assertRegex(token, r"^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$")
        status, data = self.client.post("setup", {"token": "0000-0000-0000", "login": "spravce", "name": "J", "password": PASSWORD})
        self.assertEqual(status, 403)
        status, data = self.client.post("setup", {"token": token, "login": "Špatný login", "name": "J", "password": PASSWORD})
        self.assertEqual(status, 400)
        status, data = self.client.post("setup", {"token": token, "login": "spravce", "name": "J", "password": "kratke"})
        self.assertEqual(status, 400)
        self.assertIn("8 znaků", data["error"])
        status, data = self.client.post("setup", {"token": token.lower(), "login": "spravce", "name": "Jana", "password": PASSWORD})
        self.assertEqual(status, 200, data)
        self.assertEqual(data["user"]["role"], "admin")
        self.assertIsNone(data["dept"])
        self.assertFalse((self.server.data / "setup-token.txt").exists(), "kód pro první spuštění se po použití smaže")
        status, data = Client(self.server).post("setup", {"token": token, "login": "druhy", "name": "X", "password": PASSWORD})
        self.assertEqual(status, 409)
        self.assertIn("už je nastavená", self.server.cli("bin/setup-token.php").stdout)


class AuthTests(Base):
    def test_login_wrong_password_and_throttle(self):
        anon = Client(self.server)
        status, data = anon.post("login", {"login": "spravce", "password": "spatne-heslo"})
        self.assertEqual(status, 401)
        status, data = anon.post("login", {"login": "neexistuje", "password": "spatne-heslo"})
        self.assertEqual(status, 401)
        self.assertEqual(data["error"], "Přihlašovací jméno nebo heslo nesedí.", "neexistující jméno se neprozradí")
        for _ in range(7):
            anon.post("login", {"login": "spravce", "password": "spatne-heslo"})
        status, data = anon.post("login", {"login": "spravce", "password": PASSWORD})
        self.assertEqual(status, 429, "po 8 chybách je účet na čtvrt hodiny zamčený i se správným heslem")

    def test_app_header_origin_and_client_version(self):
        status, _ = self.admin.request("GET", "/api.php?action=state", headers={"X-Etd": None})
        self.assertEqual(status, 403)
        status, _ = self.admin.post("dept", {"dept": "hala"}, headers={"Sec-Fetch-Site": "cross-site"})
        self.assertEqual(status, 403)
        status, _ = self.admin.post("dept", {"dept": "hala"}, headers={"Origin": "https://evil.example"})
        self.assertEqual(status, 403)
        status, data = self.admin.post("dept", {"dept": "hala"}, headers={"X-Etd-Client": "0"})
        self.assertEqual(status, 426)
        self.assertTrue(data["reload"])
        status, _ = self.admin.get("scan")
        self.assertEqual(status, 405, "zápis jen přes POST")

    def test_session_cookie_and_security_headers(self):
        client = Client(self.server)
        status, body, headers = client.request("POST", "/api.php?action=login", {"login": "spravce", "password": PASSWORD}, raw=True)
        self.assertEqual(status, 200)
        cookie = headers.get("Set-Cookie", "")
        self.assertIn("etd_session=", cookie)
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Strict", cookie)
        status, body, headers = client.request("GET", "/", raw=True)
        self.assertEqual(status, 200)
        csp = headers.get("Content-Security-Policy", "")
        self.assertIn("script-src 'self'", csp)
        self.assertIn("frame-ancestors 'none'", csp)
        self.assertEqual(headers.get("X-Content-Type-Options"), "nosniff")
        self.assertIn("camera=(self)", headers.get("Permissions-Policy", ""), "fotoaparát pro QR smí jen tahle stránka")
        self.assertIn("microphone=()", headers.get("Permissions-Policy", ""))
        self.assertNotIn(b"style=\"", body)
        with self.server.db() as db:
            self.assertNotIn(cookie.split("etd_session=")[1].split(";")[0], [r[0] for r in db.execute("SELECT id FROM sessions")], "v databázi je jen otisk tokenu")

    def test_https_required_outside_localhost(self):
        client = Client(self.server)
        status, body, headers = client.request("GET", "/", headers={"Host": "evidence.example"}, raw=True)
        self.assertEqual(status, 301)
        self.assertTrue(headers["Location"].startswith("https://evidence.example/"))
        status, data = client.request("GET", "/api.php?action=state", headers={"Host": "evidence.example"})
        self.assertEqual(status, 403)
        status, body, headers = client.request("GET", "/api/v1/ping", headers={"Host": "evidence.example"}, raw=True)
        self.assertEqual(status, 403)
        status, body, headers = client.request("GET", "/", headers={"Host": "evidence.example", "X-Forwarded-Proto": "https"}, raw=True)
        self.assertEqual(status, 200, "za proxy na stejném stroji stačí X-Forwarded-Proto")

    def test_private_files_are_not_served(self):
        (self.server.data / "x.txt").write_text("x")
        for path in ["/lib/etd.php", "/bin/setup-token.php", "/tests/test_http.py", "/deploy/install.sh", "/router.php",
                     "/README.md", "/API.md", "/CLAUDE.md", "/data/evidence.sqlite3", "/.git/config", "/evidence.sqlite3"]:
            status, body, _ = self.admin.request("GET", path, raw=True)
            self.assertEqual(status, 404, path)
        status, body, _ = self.admin.request("GET", "/static/app.js", raw=True)
        self.assertEqual(status, 200)
        status, body, _ = self.admin.request("GET", "/static/vendor/zxing.min.js", raw=True)
        self.assertEqual(status, 200, "knihovna pro čtení QR fotoaparátem")
        status, body, _ = self.admin.request("GET", "/static/vendor/LICENSE-zxing.txt", raw=True)
        self.assertEqual(status, 404)


class DeptTests(Base):
    def test_operator_only_allowed_depts_and_visitor(self):
        worker, info = self.user("dvorak", depts=["montaz", "elox"])
        self.assertEqual(info["depts"], ["montaz", "elox"])
        status, data = worker.post("dept", {"dept": "hala"})
        self.assertEqual(status, 403)
        state = worker.dept("elox")
        self.assertTrue(state["canWrite"])
        self.assertEqual(state["deptName"], "Elox")
        state = worker.dept("visitor")
        self.assertFalse(state["canWrite"])
        status, data = worker.scan("prijem", [{"barcode": "A1"}])
        self.assertEqual(status, 403, "Visitor nezapisuje")

        viewer, info = self.user("navsteva", role="visitor")
        self.assertEqual(info["depts"], [])
        status, _ = viewer.post("dept", {"dept": "montaz"})
        self.assertEqual(status, 403)
        viewer.dept("visitor")
        status, data = viewer.scan("prijem", [{"barcode": "A1"}])
        self.assertEqual(status, 403)
        status, data = viewer.get("search", q="A1")
        self.assertEqual(status, 200, "Visitor smí číst")

    def test_write_needs_chosen_dept(self):
        status, data = self.admin.scan("prijem", [{"barcode": "A1"}])
        self.assertEqual(status, 403)
        self.assertTrue(data["pickDept"])

    def test_removed_dept_stops_working_immediately(self):
        worker, info = self.user("dvorak", depts=["montaz", "elox"])
        worker.dept("elox")
        status, _ = self.admin.post("user_save", {"id": info["id"], "login": "dvorak", "name": "Dvořák", "role": "operator", "depts": ["montaz"], "active": True, "password": ""})
        self.assertEqual(status, 200)
        status, _ = worker.scan("prijem", [{"barcode": "A1"}])
        self.assertEqual(status, 401, "změna oddělení uživatele odhlásí")


class ScanTests(Base):
    def setUp(self):
        super().setUp()
        self.admin.dept("hala")

    def test_single_prijem_and_export_with_qty(self):
        status, data = self.admin.scan("prijem", [{"barcode": "  PR-1\r\n"}])
        self.assertEqual(status, 200, data)
        r = data["results"][0]
        self.assertEqual(r["status"], "ok")
        self.assertEqual(r["record"]["barcode"], "PR-1", "okrajové mezery a řídicí znaky ze čtečky pryč")
        self.assertIsNone(r["record"]["quantity"])
        self.assertIsNone(r["previous"])
        status, data = self.admin.scan("export", [{"barcode": "PR-1"}])
        self.assertEqual(data["results"][0]["status"], "error", "export bez počtu kusů se nezapíše")
        for bad in [0, -5, "1,5", "abc", 1000001, 2.5]:
            status, data = self.admin.scan("export", [{"barcode": "PR-1", "qty": bad}])
            self.assertEqual(data["results"][0]["status"], "error", bad)
        status, data = self.admin.scan("export", [{"barcode": "pr-1", "qty": "48"}])
        r = data["results"][0]
        self.assertEqual(r["status"], "ok", r)
        self.assertEqual(r["record"]["quantity"], 48)
        self.assertEqual(r["previous"]["action"], "prijem")
        self.assertIsNone(r["record"]["position"], "export pozici nemá")

    def test_batch_with_position_and_repeats(self):
        status, data = self.admin.scan("prijem", [{"barcode": "A"}], position="", define=True)
        self.assertEqual(status, 400, "zapnutá pozice musí být vyplněná")
        items = [{"barcode": "B-1"}, {"barcode": "B-2"}, {"barcode": "b-1"}, {"barcode": ""}, {"barcode": "x" * 201}]
        status, data = self.admin.scan("prijem", items, position="  Regál\tA3 ", define=True)
        self.assertEqual(status, 200)
        self.assertEqual([r["status"] for r in data["results"]], ["ok", "ok", "repeat", "error", "error"])
        self.assertEqual(data["written"], 2)
        self.assertEqual({r["record"]["position"] for r in data["results"][:2]}, {"Regál A3"})
        with self.server.db() as db:
            batches = {r[0] for r in db.execute("SELECT batch FROM records")}
        self.assertEqual(len(batches), 1, "průvodky z jedné dávky mají společné označení dávky")
        status, data = self.admin.scan("prijem", [{"barcode": str(i)} for i in range(501)])
        self.assertEqual(status, 400)

    def test_duplicate_within_ten_minutes_needs_force(self):
        self.admin.scan("prijem", [{"barcode": "D-1"}])
        status, data = self.admin.scan("prijem", [{"barcode": "d-1"}])
        r = data["results"][0]
        self.assertEqual(r["status"], "duplicate")
        self.assertEqual(r["last"]["barcode"], "D-1")
        status, data = self.admin.scan("prijem", [{"barcode": "d-1"}], force=True)
        self.assertEqual(data["results"][0]["status"], "ok")
        # export po příjmu není duplicita; a jiné pracoviště také ne
        status, data = self.admin.scan("export", [{"barcode": "D-1", "qty": 5}])
        self.assertEqual(data["results"][0]["status"], "ok")
        with self.server.db() as db:
            db.execute("UPDATE records SET created_at = created_at - 700")
        status, data = self.admin.scan("export", [{"barcode": "D-1", "qty": 5}])
        self.assertEqual(data["results"][0]["status"], "ok", "po 10 minutách už to dvojí načtení není")

    def test_positions_suggestions(self):
        self.admin.scan("prijem", [{"barcode": "P-1"}], position="Regál A3", define=True)
        self.admin.scan("prijem", [{"barcode": "P-2"}], position="B2", define=True)
        status, data = self.admin.get("positions")
        self.assertEqual(data["positions"], ["B2", "Regál A3"])


class SearchTests(Base):
    def setUp(self):
        super().setUp()
        self.admin.dept("brouseni_wpa")
        self.admin.scan("prijem", [{"barcode": "PR-100"}])
        self.admin.scan("export", [{"barcode": "PR-100", "qty": 10}])
        self.admin.dept("hala")
        self.admin.scan("prijem", [{"barcode": "PR-100"}], position="H1", define=True)
        self.admin.scan("prijem", [{"barcode": "PR-1000"}, {"barcode": "X_1%"}])

    def test_exact_history_newest_first_and_partial(self):
        status, data = self.admin.get("search", q="pr-100")
        self.assertEqual(status, 200)
        ex = data["exact"]
        self.assertEqual(ex["count"], 3)
        self.assertEqual([r["action"] + ":" + r["department"] for r in ex["history"]], ["prijem:hala", "export:brouseni_wpa", "prijem:brouseni_wpa"])
        self.assertEqual(ex["last"]["position"], "H1")
        self.assertEqual([m["barcode"] for m in data["matches"]], ["PR-1000"], "částečná shoda bez přesné")
        status, data = self.admin.get("search", q="_")
        self.assertEqual([m["barcode"] for m in data["matches"]], ["X_1%"], "_ a % se hledají doslova")
        status, data = self.admin.get("search", q="nic")
        self.assertIsNone(data["exact"])
        self.assertEqual(data["matches"], [])

    def test_records_filter_and_paging(self):
        status, data = self.admin.get("records", dept="hala", limit=2)
        self.assertEqual(len(data["records"]), 2)
        self.assertTrue(data["more"])
        status, data2 = self.admin.get("records", dept="hala", limit=2, before=data["records"][-1]["id"])
        self.assertEqual(len(data2["records"]), 1)
        self.assertFalse(data2["more"])
        status, data = self.admin.get("records", type="export")
        self.assertEqual([r["quantity"] for r in data["records"]], [10])

    def test_onsite(self):
        status, data = self.admin.get("onsite")
        by = {d["code"]: d for d in data["depts"]}
        self.assertEqual(len(by), 7)
        self.assertEqual(by["hala"]["total"], 3)
        self.assertEqual(by["brouseni_wpa"]["total"], 0, "po exportu průvodka na Broušení není")
        self.admin.scan("export", [{"barcode": "PR-100", "qty": 9}])
        status, data = self.admin.get("onsite")
        self.assertEqual({d["code"]: d["total"] for d in data["depts"]}["hala"], 2)


class CancelTests(Base):
    def test_cancel_rules_and_last_state(self):
        worker, _ = self.user("dvorak", depts=["hala", "montaz"])
        worker.dept("hala")
        other, _ = self.user("novak", depts=["hala"])
        other.dept("hala")
        worker.scan("prijem", [{"barcode": "C-1"}])
        status, data = worker.scan("export", [{"barcode": "C-1", "qty": 3}])
        rid = data["results"][0]["id"]
        status, data = other.post("cancel", {"id": rid})
        self.assertEqual(status, 403, "cizí záznam pracovník nestornuje")
        worker.dept("montaz")
        status, data = worker.post("cancel", {"id": rid})
        self.assertEqual(status, 403, "jen z pracoviště záznamu")
        worker.dept("hala")
        status, data = worker.post("cancel", {"id": rid, "reason": "špatný počet"})
        self.assertEqual(status, 200, data)
        self.assertEqual(data["record"]["cancelled"]["reason"], "špatný počet")
        self.assertEqual(data["last"]["action"], "prijem", "poslední stav se vrátí na předchozí platný záznam")
        status, data = worker.post("cancel", {"id": rid})
        self.assertEqual(status, 409)
        # starší než 30 minut: autor už ne, správce ano
        status, data = worker.scan("prijem", [{"barcode": "C-2"}])
        old = data["results"][0]["id"]
        with self.server.db() as db:
            db.execute("UPDATE records SET created_at = created_at - 1900 WHERE id = ?", (old,))
        status, _ = worker.post("cancel", {"id": old})
        self.assertEqual(status, 403)
        status, data = self.admin.post("cancel", {"id": old})
        self.assertEqual(status, 200)
        self.assertIsNone(data["last"])
        with self.server.db() as db:
            self.assertIsNone(db.execute("SELECT * FROM parts WHERE barcode = 'C-2'").fetchone())
        status, data = self.admin.get("search", q="C-2")
        self.assertIsNone(data["exact"]["last"])
        self.assertEqual(len(data["exact"]["history"]), 1, "stornovaný záznam zůstane v historii")

    def test_recent_shows_can_cancel(self):
        worker, _ = self.user("dvorak", depts=["hala"])
        worker.dept("hala")
        worker.scan("prijem", [{"barcode": "R-1"}])
        self.admin.dept("hala")
        self.admin.scan("prijem", [{"barcode": "R-2"}])
        status, data = worker.get("recent")
        self.assertEqual({r["barcode"]: r["canCancel"] for r in data["records"]}, {"R-1": True, "R-2": False})


class UserAdminTests(Base):
    def test_user_rules(self):
        status, data = self.admin.post("user_save", {"login": "spravce", "name": "X", "role": "operator", "depts": ["hala"], "password": PASSWORD})
        self.assertEqual(status, 409, "stejné přihlašovací jméno")
        status, data = self.admin.post("user_save", {"login": "x", "name": "X", "role": "operator", "depts": [], "password": PASSWORD})
        self.assertEqual(status, 400)
        status, data = self.admin.post("user_save", {"login": "kratke", "name": "X", "role": "operator", "depts": ["hala"], "password": "123"})
        self.assertEqual(status, 400)
        status, users = self.admin.get("users")
        me = users["users"][0]
        status, data = self.admin.post("user_save", {"id": me["id"], "login": "spravce", "name": "Jana", "role": "operator", "depts": ["hala"], "active": True, "password": ""})
        self.assertEqual(status, 409, "správce si sám roli neodebere")
        worker, info = self.user("dvorak", depts=["hala"])
        status, _ = worker.get("users")
        self.assertEqual(status, 403)
        status, _ = worker.post("apikey_create", {"name": "x"})
        self.assertEqual(status, 403)
        # vypnutí účtu odhlásí hned
        status, _ = self.admin.post("user_save", {"id": info["id"], "login": "dvorak", "name": "Dvořák", "role": "operator", "depts": ["hala"], "active": False, "password": ""})
        self.assertEqual(status, 200)
        status, _ = worker.get("recent")
        self.assertEqual(status, 401)
        status, data = Client(self.server).post("login", {"login": "dvorak", "password": PASSWORD})
        self.assertEqual(status, 401)
        self.assertIn("vypnutý", data["error"])
        status, log = self.admin.get("adminlog")
        self.assertTrue(any("vypnut" in l["text"] for l in log["log"]))

    def test_must_change_password(self):
        worker, info = self.user("dvorak", depts=["hala"], must_change=True)
        status, state = worker.get("state")
        self.assertTrue(state["user"]["mustChange"])
        self.assertFalse(state["canWrite"])
        worker.dept("hala")
        status, data = worker.scan("prijem", [{"barcode": "M-1"}])
        self.assertEqual(status, 403)
        status, data = worker.post("password", {"old": PASSWORD, "new": PASSWORD})
        self.assertEqual(status, 400, "nové heslo musí být jiné")
        status, data = worker.post("password", {"old": "spatne", "new": "noveheslo1"})
        self.assertEqual(status, 403)
        second = Client(self.server)
        second.login("dvorak")
        status, state = worker.post("password", {"old": PASSWORD, "new": "noveheslo1"})
        self.assertEqual(status, 200)
        self.assertFalse(state["user"]["mustChange"])
        status, _ = second.get("recent")
        self.assertEqual(status, 401, "změna hesla odhlásí ostatní přihlášení")
        status, data = worker.scan("prijem", [{"barcode": "M-1"}])
        self.assertEqual(status, 200)

    def test_reset_password_cli(self):
        out = self.server.cli("bin/reset-password.php", "spravce")
        self.assertEqual(out.returncode, 0, out.stderr)
        temp = out.stdout.strip().rsplit(" ", 1)[-1]
        status, _ = self.admin.get("recent")
        self.assertEqual(status, 401, "staré přihlášení skončí")
        client = Client(self.server)
        state = client.login("spravce", temp)
        self.assertTrue(state["user"]["mustChange"])


class ApiV1Tests(Base):
    def setUp(self):
        super().setUp()
        self.admin.dept("brush_wpa")
        self.admin.scan("prijem", [{"barcode": "PR-2026-1"}], position="R1", define=True)
        self.admin.scan("export", [{"barcode": "PR-2026-1", "qty": 48}])
        status, data = self.admin.post("apikey_create", {"name": "ERP"})
        self.assertEqual(status, 200)
        self.key = data["key"]
        self.key_id = data["id"]

    def api(self, path, key=None, header="Authorization", method="GET", body=None):
        client = Client(self.server)
        headers = {"X-Etd": None, "X-Etd-Client": None}
        if key:
            headers[header] = ("Bearer " + key) if header == "Authorization" else key
        return client.request(method, path, body, headers=headers)

    def test_last_history_batch_and_ping(self):
        status, data = self.api("/api/v1/last?barcode=pr-2026-1", self.key)
        self.assertEqual(status, 200, data)
        rec = data["record"]
        self.assertEqual((rec["action"], rec["department"], rec["quantity"], rec["position"]), ("export", "brush_wpa", 48, None))
        self.assertEqual(rec["department_label"], "Brush WPA")
        self.assertRegex(rec["recorded_at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+0[12]:00$")
        self.assertTrue(rec["recorded_at_utc"].endswith("Z"))
        status, data = self.api("/api/v1/last?barcode=PR-2026-1", self.key, header="X-Api-Key")
        self.assertEqual(status, 200)
        status, data = self.api("/api/v1/last?barcode=neni", self.key)
        self.assertEqual((status, data["error"], data["found"]), (404, "not_found", False))
        status, data = self.api("/api/v1/last", self.key)
        self.assertEqual(status, 400)
        status, data = self.api("/api/v1/history?barcode=PR-2026-1", self.key)
        self.assertEqual([r["action"] for r in data["records"]], ["export", "prijem"])
        self.assertEqual(data["records"][1]["position"], "R1")
        status, data = self.api("/api/v1/last", self.key, method="POST", body={"barcodes": ["PR-2026-1", "neni", ""]})
        self.assertEqual(status, 200, data)
        self.assertEqual([r["found"] for r in data["results"]], [True, False, False])
        status, data = self.api("/api/v1/ping", self.key)
        self.assertEqual((status, data["key"]), (200, "ERP"))
        status, data = self.api("/api/v1/index.php?endpoint=last&barcode=PR-2026-1", self.key)
        self.assertEqual(status, 200, "bez přepisu cest jde i ?endpoint=")
        status, data = self.api("/api/v1/nic", self.key)
        self.assertEqual(status, 404)
        status, data = self.api("/api/v1/last", self.key, method="POST", body={"barcodes": ["x"] * 501})
        self.assertEqual(status, 400)

    def test_cancelled_records_are_not_last(self):
        status, data = self.admin.get("search", q="PR-2026-1")
        self.admin.post("cancel", {"id": data["exact"]["last"]["id"]})
        status, data = self.api("/api/v1/last?barcode=PR-2026-1", self.key)
        self.assertEqual(data["record"]["action"], "prijem")
        status, data = self.api("/api/v1/history?barcode=PR-2026-1", self.key)
        self.assertEqual(data["count"], 1)

    def test_key_required_hashed_and_revocable(self):
        status, data = self.api("/api/v1/last?barcode=PR-2026-1")
        self.assertEqual((status, data["error"]), (401, "unauthorized"))
        status, data = self.api("/api/v1/last?barcode=PR-2026-1&key=" + self.key)
        self.assertEqual(status, 401, "klíč v adrese se nebere")
        status, data = self.api("/api/v1/last?barcode=PR-2026-1", "etd_" + "0" * 40)
        self.assertEqual(status, 401)
        status, data = Client(self.server).request("GET", "/api/v1/last?barcode=PR-2026-1", headers={"Cookie": "x"})
        self.assertEqual(status, 401, "relace z prohlížeče API pro IT neotevře")
        status, data = self.api("/api/v1/ping", self.key)
        self.assertEqual(status, 200)
        with self.server.db() as db:
            dump = "\n".join(db.iterdump())
        self.assertNotIn(self.key, dump, "v databázi je jen otisk klíče")
        status, keys = self.admin.get("apikeys")
        self.assertIsNotNone(keys["keys"][0]["lastUsedAt"])
        self.assertNotIn("key", keys["keys"][0])
        self.admin.post("apikey_revoke", {"id": self.key_id})
        status, data = self.api("/api/v1/last?barcode=PR-2026-1", self.key)
        self.assertEqual(status, 401)

    def test_bad_keys_are_throttled(self):
        for _ in range(60):
            self.api("/api/v1/ping", "etd_" + "1" * 40)
        status, data = self.api("/api/v1/ping", self.key)
        self.assertEqual(status, 429)


class DataTests(Base):
    def test_backup_rebuild_and_reopen_keep_data(self):
        self.admin.dept("hala")
        self.admin.scan("prijem", [{"barcode": f"B-{i}"} for i in range(30)], position="A1", define=True)
        self.admin.scan("export", [{"barcode": "B-1", "qty": 2}])
        with self.server.db() as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 2)
            parts_before = sorted(db.execute("SELECT barcode, last_id, last_action, last_dept FROM parts").fetchall())
        backups = self.server.data / "zalohy"
        out = self.server.cli("bin/backup-db.php", str(backups))
        self.assertEqual(out.returncode, 0, out.stderr)
        backup = Path(out.stdout.strip())
        with sqlite3.connect(backup) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM records").fetchone()[0], 31)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM users").fetchone()[0], 1)
        out = self.server.cli("bin/rebuild-parts.php")
        self.assertIn("30 průvodek", out.stdout)
        with self.server.db() as db:
            self.assertEqual(sorted(db.execute("SELECT barcode, last_id, last_action, last_dept FROM parts").fetchall()), parts_before)
        # restart serveru (jako aktualizace): data i přihlášení zůstanou
        self.server.stop()
        restarted = Server(self.server.data)
        try:
            client = Client(restarted)
            client.login("spravce")
            status, data = client.get("search", q="B-1")
            self.assertEqual(data["exact"]["last"]["quantity"], 2)
        finally:
            restarted.stop()
        self.server = Server(self.server.data)


class FirstLoginTests(Base):
    """Uživatel bez hesla: správce ho založí, heslo si uživatel nastaví při prvním přihlášení."""

    def new_pending(self, login="novak"):
        status, data = self.admin.post("user_save", {"login": login, "name": "Jan Novák", "role": "operator", "depts": ["hala"],
                                                     "passwordMode": "self", "active": True})
        self.assertEqual(status, 200, data)
        return data["user"]

    def test_user_without_password_sets_it_at_first_login(self):
        info = self.new_pending()
        self.assertTrue(info["pending"])
        self.assertFalse(info["pendingExpired"])
        self.assertIsNotNone(info["pendingUntil"])
        with self.server.db() as db:
            self.assertEqual(db.execute("SELECT pass_hash FROM users WHERE login = 'novak'").fetchone()[0], "")
        client = Client(self.server)
        status, data = client.post("login", {"login": "Novak", "password": ""})
        self.assertEqual((status, data.get("needPassword"), data.get("login")), (200, True, "novak"))
        status, _ = client.get("recent")
        self.assertEqual(status, 401, "výzva k nastavení hesla ještě nikoho nepřihlásí")
        status, data = client.post("login", {"login": "novak", "password": "cokoli-123"})
        self.assertTrue(data.get("needPassword"), "účet bez hesla neotevře žádné heslo")
        status, data = client.post("first_password", {"login": "novak", "password": "kratke"})
        self.assertEqual(status, 400)
        status, state = client.post("first_password", {"login": "novak", "password": "mojeheslo1"})
        self.assertEqual(status, 200, state)
        self.assertEqual(state["user"]["login"], "novak")
        self.assertFalse(state["user"]["pending"])
        self.assertTrue(client.dept("hala")["canWrite"])
        status, data = Client(self.server).post("first_password", {"login": "novak", "password": "jineheslo1"})
        self.assertEqual(status, 403, "nastavené heslo už nikdo jiný nepřepíše")
        Client(self.server).login("novak", "mojeheslo1")
        status, log = self.admin.get("adminlog")
        self.assertTrue(any("při prvním přihlášení nastavil" in l["text"] for l in log["log"]))

    def test_empty_password_and_unknown_login(self):
        client = Client(self.server)
        status, data = client.post("login", {"login": "spravce", "password": ""})
        self.assertEqual((status, data["error"]), (400, "Vyplň heslo."))
        status, data = client.post("login", {"login": "neexistuje", "password": ""})
        self.assertEqual((status, data["error"]), (400, "Vyplň heslo."), "neexistující jméno se neprozradí")
        status, data = client.post("first_password", {"login": "spravce", "password": "noveheslo1"})
        self.assertEqual(status, 403, "účet s heslem si ho takhle nezmění")
        status, data = client.post("first_password", {"login": "neexistuje", "password": "noveheslo1"})
        self.assertEqual(status, 403)
        Client(self.server).login("spravce")

    def test_invite_expires_and_admin_renews(self):
        info = self.new_pending()
        with self.server.db() as db:
            db.execute("UPDATE users SET pending_until = ? WHERE login = 'novak'", (int(time.time()) - 1,))
        status, data = Client(self.server).post("login", {"login": "novak", "password": ""})
        self.assertEqual(status, 403)
        self.assertIn("vypršel", data["error"])
        status, _ = Client(self.server).post("first_password", {"login": "novak", "password": "mojeheslo1"})
        self.assertEqual(status, 403)
        status, users = self.admin.get("users")
        self.assertTrue(next(u for u in users["users"] if u["login"] == "novak")["pendingExpired"])
        status, data = self.admin.post("user_save", {"id": info["id"], "login": "novak", "name": "Jan Novák", "role": "operator",
                                                     "depts": ["hala"], "active": True, "passwordMode": "self"})
        self.assertEqual(status, 200)
        self.assertFalse(data["user"]["pendingExpired"], "správce čas obnoví")
        status, _ = Client(self.server).post("first_password", {"login": "novak", "password": "mojeheslo1"})
        self.assertEqual(status, 200)

    def test_admin_lets_existing_user_choose_new_password(self):
        worker, info = self.user("dvorak", depts=["hala"])
        status, data = self.admin.post("user_save", {"id": info["id"], "login": "dvorak", "name": "Dvořák", "role": "operator",
                                                     "depts": ["hala"], "active": True, "passwordMode": "self"})
        self.assertEqual(status, 200)
        self.assertTrue(data["user"]["pending"])
        status, _ = worker.get("recent")
        self.assertEqual(status, 401, "staré přihlášení skončí")
        status, data = Client(self.server).post("login", {"login": "dvorak", "password": PASSWORD})
        self.assertTrue(data.get("needPassword"), "staré heslo přestalo platit")
        status, data = self.admin.post("user_save", {"id": info["id"], "login": "dvorak", "name": "Petr Dvořák", "role": "operator",
                                                     "depts": ["hala"], "active": True, "passwordMode": "keep"})
        self.assertTrue(data["user"]["pending"], "úprava jména stav hesla nemění")
        status, users = self.admin.get("users")
        me = next(u for u in users["users"] if u["login"] == "spravce")
        status, _ = self.admin.post("user_save", {"id": me["id"], "login": "spravce", "name": "Jana", "role": "admin", "depts": [],
                                                  "active": True, "passwordMode": "self"})
        self.assertEqual(status, 409, "správce si vlastní heslo takhle nezruší")

    def test_disabled_user_cannot_set_password(self):
        info = self.new_pending()
        self.admin.post("user_save", {"id": info["id"], "login": "novak", "name": "Jan Novák", "role": "operator", "depts": ["hala"],
                                      "active": False, "passwordMode": "keep"})
        status, data = Client(self.server).post("login", {"login": "novak", "password": ""})
        self.assertNotIn("needPassword", data if isinstance(data, dict) else {})
        status, _ = Client(self.server).post("first_password", {"login": "novak", "password": "mojeheslo1"})
        self.assertEqual(status, 403)


# Schéma databáze verze 1.0 (beze změny z lib/etd.php té verze): test aktualizace na verzi 1.1+.
V1_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    login TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    pass_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    depts TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    must_change INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_login_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    dept TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ip TEXT,
    user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
-- Záznamy se nemažou. Chybný záznam se stornuje (cancelled_at) a do posledního stavu se nepočítá.
CREATE TABLE IF NOT EXISTS records (
    id INTEGER PRIMARY KEY,
    barcode TEXT NOT NULL,
    action TEXT NOT NULL,
    dept TEXT NOT NULL,
    position TEXT,
    qty INTEGER,
    user_id INTEGER,
    user_name TEXT NOT NULL,
    user_login TEXT NOT NULL,
    batch TEXT,
    created_at INTEGER NOT NULL,
    cancelled_at INTEGER,
    cancelled_by TEXT,
    cancel_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_records_barcode ON records(barcode COLLATE NOCASE, id);
CREATE INDEX IF NOT EXISTS idx_records_dept ON records(dept, id);
-- Poslední platný záznam každé průvodky (odvozené z records, jde kdykoli přepočítat).
CREATE TABLE IF NOT EXISTS parts (
    barcode TEXT PRIMARY KEY COLLATE NOCASE,
    last_id INTEGER NOT NULL,
    last_action TEXT NOT NULL,
    last_dept TEXT NOT NULL,
    updated_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_parts_state ON parts(last_dept, last_action, updated_at);
CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    last_ip TEXT,
    revoked_at INTEGER,
    revoked_by TEXT
);
CREATE TABLE IF NOT EXISTS attempts (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    subject TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts ON attempts(kind, subject, created_at);
CREATE TABLE IF NOT EXISTS admin_log (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    by_name TEXT NOT NULL,
    text TEXT NOT NULL
);
"""


class UpgradeTests(unittest.TestCase):
    def test_version_1_0_database_upgrades_without_data_loss(self):
        data = Path(tempfile.mkdtemp(prefix="etd-v1-"))
        hashed = subprocess.run([PHP, "-r", f"echo password_hash('{PASSWORD}', PASSWORD_DEFAULT);"], capture_output=True, text=True).stdout
        key = "etd_" + "ab" * 20
        now = int(time.time())
        with sqlite3.connect(data / "evidence.sqlite3") as db:
            db.executescript(V1_SCHEMA)
            db.execute("PRAGMA user_version = 1")
            db.execute("INSERT INTO users (login, name, pass_hash, role, depts, active, must_change, created_at, updated_at) VALUES ('spravce', 'Jana', ?, 'admin', '', 1, 0, ?, ?)", (hashed, now, now))
            db.execute("INSERT INTO records (barcode, action, dept, position, qty, user_id, user_name, user_login, created_at) VALUES ('U-1', 'prijem', 'hala', 'A1', NULL, 1, 'Jana', 'spravce', ?)", (now - 100,))
            db.execute("INSERT INTO records (barcode, action, dept, position, qty, user_id, user_name, user_login, created_at) VALUES ('U-1', 'export', 'hala', NULL, 12, 1, 'Jana', 'spravce', ?)", (now - 50,))
            db.execute("INSERT INTO parts (barcode, last_id, last_action, last_dept, updated_at) VALUES ('U-1', 2, 'export', 'hala', ?)", (now - 50,))
            db.execute("INSERT INTO api_keys (name, prefix, key_hash, created_by, created_at) VALUES ('ERP', ?, ?, 'Jana', ?)",
                       (key[:12], __import__("hashlib").sha256(key.encode()).hexdigest(), now))
        server = Server(data)
        try:
            client = Client(server)
            state = client.login("spravce")
            self.assertNotEqual(state["version"], "1.0", "běží novější verze")
            self.assertFalse(state["user"]["pending"])
            status, found = client.get("search", q="u-1")
            self.assertEqual([r["action"] for r in found["exact"]["history"]], ["export", "prijem"])
            status, last = client.request("GET", "/api/v1/last?barcode=U-1", headers={"X-Etd": None, "X-Etd-Client": None, "Authorization": "Bearer " + key})
            self.assertEqual((status, last["record"]["quantity"]), (200, 12), "API klíč z verze 1.0 platí dál")
            status, data_ = client.post("user_save", {"login": "novak", "name": "Novák", "role": "operator", "depts": ["hala"], "passwordMode": "self", "active": True})
            self.assertEqual(status, 200, data_)
            with server.db() as db:
                self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 2)
                self.assertIn("pending_until", [r[1] for r in db.execute("PRAGMA table_info(users)")])
                self.assertEqual(db.execute("SELECT COUNT(*) FROM records").fetchone()[0], 2)
        finally:
            server.stop()
            shutil.rmtree(data, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
