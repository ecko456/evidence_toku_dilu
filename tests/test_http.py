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
    def __init__(self, data=None, **env):
        self.data = Path(data) if data else Path(tempfile.mkdtemp(prefix="etd-"))
        self.port = free_port()
        self.base = f"http://127.0.0.1:{self.port}"
        self.env = dict(os.environ, ETD_DATA_DIR=str(self.data), NO_PROXY="*", **env)
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

    SERVER_ENV = {}

    def setUp(self):
        self.server = Server(**self.SERVER_ENV)
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
        self.assertEqual([d["name"] for d in state["depts"]], ["Broušení WPA", "Brush WPA", "Hala 2", "Montáž", "Elox", "Studio", "CNC Hala2"])
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
        self.assertFalse(r["record"]["complete"])
        # 1.7: kompletní export bez počtu kusů
        status, data = self.admin.scan("export", [{"barcode": "PR-1", "complete": True, "qty": "0"}])
        self.assertEqual(data["results"][0]["status"], "error", "complete s neplatným počtem kusů se nezapíše")
        status, data = self.admin.scan("export", [{"barcode": "PR-1", "complete": True}], force=True)
        r = data["results"][0]
        self.assertEqual(r["status"], "ok", r)
        self.assertIsNone(r["record"]["quantity"])
        self.assertTrue(r["record"]["complete"])

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


class WatchApiTests(Base):
    """Živé propojení s Google tabulkou (1.3): seznam sledovaných barcodů a fronta změn.
    Celou cestu až do tabulky (podpis, doPost, zápis do listu) zkouší tests/e2e_sheets.js."""

    SERVER_ENV = {"ETD_HOOK_TEST": "1"}   # povolí náhradní „Google“ na 127.0.0.1; ven nejde nic
    URL = "https://script.google.com/macros/s/AKfycbx1234567890abcdefghijXYZ/exec"
    SECRET = "s" * 64

    def setUp(self):
        super().setUp()
        self.admin.dept("hala")
        self.admin.scan("prijem", [{"barcode": "12345.1.1"}, {"barcode": "12345.1.2"}], position="R3", define=True)
        status, data = self.admin.post("apikey_create", {"name": "Kooperace"})
        self.key = data["key"]

    def watch(self, body=None, method="POST", key=None):
        headers = {"X-Etd": None, "X-Etd-Client": None, "Authorization": "Bearer " + (key or self.key)}
        return Client(self.server).request(method, "/api/v1/watch", body, headers=headers)

    def queue(self):
        with self.server.db() as db:
            return sorted(r[0] for r in db.execute("SELECT barcode FROM hook_queue"))

    def test_validation(self):
        good = {"url": self.URL, "secret": self.SECRET, "barcodes": ["12345.1.1"]}
        cases = [
            dict(good, url="https://example.com/macros/s/AKfycbx1234567890abcdefghijXYZ/exec"),
            dict(good, url="https://script.google.com.example.com/macros/s/AKfycbx1234567890abcdefghijXYZ/exec"),
            dict(good, url="https://script.google.com/macros/s/AKfycbx1234567890abcdefghijXYZ/exec/../x/exec"),
            dict(good, secret="kratky"),
            dict(good, barcodes="12345.1.1"),
            dict(good, barcodes=["x"] * 10001),
        ]
        for body in cases:
            status, data = self.watch(body)
            self.assertEqual((status, data["error"]), (400, "bad_request"), body if len(str(body)) < 300 else "10001 barcodů")
        # mimo testy adresa na tenhle stroj neprojde
        env = {k: v for k, v in self.server.env.items() if k != "ETD_HOOK_TEST"}
        out = subprocess.run([PHP, "-r", 'require "lib/etd.php"; echo json_encode([etd_hook_url_valid("http://127.0.0.1:9/macros/s/x/exec"), etd_hook_url_valid("%s")]);' % self.URL],
                             cwd=APP, env=env, capture_output=True, text=True)
        self.assertEqual(out.stdout, "[false,true]", out.stderr)
        status, data = self.watch(method="PUT", body=good)
        self.assertEqual(status, 405)
        status, data = self.watch(method="GET")
        self.assertEqual((status, data["connected"]), (200, False))
        status, data = self.watch(dict(good, url="https://script.google.com/a/macros/firma.cz/s/AKfycbx1234567890abcdefghijXYZ/exec"))
        self.assertEqual(status, 200, "firemní adresa Workspace")
        # adresa zkopírovaná s /u/1/ (víc účtů v prohlížeči), mezerami a ?… se srovná
        status, data = self.watch(dict(good, url=" https://script.google.com/macros/u/1/s/AKfycbx1234567890abcdefghijXYZ/exec?usp=sharing\n"))
        self.assertEqual(status, 200, data)
        with self.server.db() as db:
            self.assertEqual(db.execute("SELECT url FROM hooks").fetchone()[0], self.URL)
        status, data = self.watch(dict(good, url="https://script.google.com/macros/s/AKfycbx1234567890abcdefghijXYZ/dev"))
        self.assertEqual(status, 400)
        self.assertIn("Přišlo: „https://script.google.com/macros/s/AKfycb…/dev“", data["message"])
        self.assertIn("/dev", data["message"])
        status, data = self.watch(dict(good, url="https://script.google.com/home/projects/1abc/edit"))
        self.assertIn("adresa editoru", data["message"])

    def test_register_queue_and_unregister(self):
        self.URL = f"http://127.0.0.1:{free_port()}/macros/s/zavreny/exec"   # „Google“, který neodpovídá
        status, data = self.watch({"url": self.URL, "secret": self.SECRET, "barcodes": ["12345.1.1", "12345.1.1", "12345.1.2", "12345.1.3", "", None, "x" * 201]})
        self.assertEqual(status, 200, data)
        self.assertEqual((data["watching"], data["found"], data["skipped"]), (3, 2, 2))
        self.assertEqual([r["barcode"] for r in data["results"]], ["12345.1.1", "12345.1.2"])
        self.assertRegex(data["results"][0]["text"], r"^Příjem na pracoviště · Hala 2 · pozice R3 · \d+\. \d+\. \d{4} \d+:\d\d · Jana Správcová$")
        self.assertEqual(data["results"][0]["record"]["position"], "R3")
        self.assertFalse(data["worker"]["running"])
        # příjem, export i storno sledované průvodky ji zařadí do fronty (jednou), nesledované ne
        self.admin.scan("export", [{"barcode": "12345.1.1", "qty": 3}])
        self.admin.scan("prijem", [{"barcode": "12345.1.3"}, {"barcode": "JINA"}])
        self.assertEqual(self.queue(), ["12345.1.1", "12345.1.3"])
        status, recent = self.admin.get("recent")
        self.admin.post("cancel", {"id": next(r["id"] for r in recent["records"] if r["barcode"] == "12345.1.3")})
        self.assertEqual(self.queue(), ["12345.1.1", "12345.1.3"])
        with self.server.db() as db:
            vers = dict(db.execute("SELECT barcode, ver FROM hook_queue"))
        self.assertEqual(vers["12345.1.3"], 2, "druhá změna zvýšila verzi, nepřidala řádek")
        # nový seznam: z fronty zmizí, co už se nesleduje; logy jen při zapnutí
        status, data = self.watch({"url": self.URL, "secret": self.SECRET, "barcodes": ["12345.1.1"]})
        self.assertEqual(self.queue(), ["12345.1.1"])
        status, data = self.watch(method="GET")
        self.assertEqual((data["connected"], data["status"]["watching"], data["status"]["queued"], data["status"]["status"]), (True, 1, 1, "waiting"))
        status, log = self.admin.get("adminlog")
        self.assertEqual(sum("Připojena tabulka" in l["text"] for l in log["log"]), 1)
        # Google nedostupný: úloha zapíše chybu a počká, fronta zůstane
        out = self.server.cli("bin/hook-worker.php", "--once")
        self.assertIn("Odesláno průvodek: 0", out.stdout)
        status, hooks = self.admin.get("hooks")
        h = hooks["hooks"][0]
        self.assertEqual((h["status"], h["queued"], h["keyName"]), ("error", 1, "Kooperace"))
        self.assertTrue(h["lastError"])
        self.assertIsNotNone(h["retryAt"])
        self.assertNotIn(self.SECRET, json.dumps(hooks), "tajný kód se ve Správě neukazuje")
        self.assertTrue(hooks["worker"]["running"])
        # vypnutí
        status, data = self.watch(method="DELETE")
        self.assertEqual((status, data["removed"]), (200, True))
        self.assertEqual(self.queue(), [])
        status, hooks = self.admin.get("hooks")
        self.assertEqual(hooks["hooks"], [])

    def test_unreachable_sheet_is_reported(self):
        status, data = self.watch({"url": f"http://127.0.0.1:{free_port()}/macros/s/x/exec", "secret": self.SECRET, "barcodes": [], "ping": True})
        self.assertEqual(status, 200, data)
        self.assertFalse(data["ping"]["ok"])
        self.assertIn("nespojil", data["ping"]["error"])
        status, hooks = self.admin.get("hooks")
        self.assertEqual(hooks["hooks"][0]["status"], "error")
        self.assertIn("…", self.watch_url_masked())

    def watch_url_masked(self):
        self.watch({"url": self.URL, "secret": self.SECRET, "barcodes": []})
        return self.admin.get("hooks")[1]["hooks"][0]["url"]

    def test_page_actions_are_admin_only(self):
        self.watch({"url": self.URL, "secret": self.SECRET, "barcodes": ["12345.1.1"]})
        worker, _ = self.user("dvorak", depts=["hala"])
        for action in ("hooks",):
            status, _ = worker.get(action)
            self.assertEqual(status, 403)
        for action in ("hook_resend", "hook_ping", "hook_delete"):
            status, _ = worker.post(action, {"id": 1})
            self.assertEqual(status, 403)
        status, data = self.admin.post("hook_resend", {"id": 1})
        self.assertEqual((status, data["queued"]), (200, 1))
        status, data = self.admin.post("hook_delete", {"id": 99})
        self.assertEqual(status, 404)


V3_HOOKS = """
CREATE TABLE hooks (id INTEGER PRIMARY KEY, api_key_id INTEGER NOT NULL UNIQUE REFERENCES api_keys(id), url TEXT NOT NULL, secret TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1, watch_count INTEGER NOT NULL DEFAULT 0, sent_count INTEGER NOT NULL DEFAULT 0, last_ok_at INTEGER, last_error TEXT,
    last_error_at INTEGER, fails INTEGER NOT NULL DEFAULT 0, retry_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE hook_watch (hook_id INTEGER NOT NULL REFERENCES hooks(id) ON DELETE CASCADE, barcode TEXT NOT NULL COLLATE NOCASE, PRIMARY KEY (hook_id, barcode)) WITHOUT ROWID;
CREATE INDEX idx_hook_watch_barcode ON hook_watch(barcode);
CREATE TABLE hook_queue (hook_id INTEGER NOT NULL REFERENCES hooks(id) ON DELETE CASCADE, barcode TEXT NOT NULL COLLATE NOCASE, ver INTEGER NOT NULL DEFAULT 1,
    queued_at INTEGER NOT NULL, PRIMARY KEY (hook_id, barcode)) WITHOUT ROWID;
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
"""


class SheetsV14Tests(Base):
    """1.4: víc tabulek na jeden klíč (rozlišené ref) a tabulky s urgenty."""

    SERVER_ENV = {"ETD_HOOK_TEST": "1"}
    SECRET = "s" * 64

    def setUp(self):
        super().setUp()
        status, data = self.admin.post("apikey_create", {"name": "Tabulky"})
        self.key = data["key"]
        self.url = f"http://127.0.0.1:{free_port()}/macros/s/zavreny/exec"

    def watch(self, body=None, method="POST", query=""):
        headers = {"X-Etd": None, "X-Etd-Client": None, "Authorization": "Bearer " + self.key}
        return Client(self.server).request(method, "/api/v1/watch" + query, body, headers=headers)

    def body(self, **kw):
        return dict({"url": self.url, "secret": self.SECRET, "barcodes": ["U-1", "U-2"]}, **kw)

    def test_more_sheets_per_key(self):
        self.assertEqual(self.watch(self.body())[0], 200)                       # skript 1.3: bez ref
        self.assertEqual(self.watch(self.body(barcodes=["U-3"]))[0], 200)       # tentýž (bez ref) se jen přepíše
        self.assertEqual(self.watch(self.body(ref="t1#0", name="Kooperace / List 1"))[0], 200)
        self.assertEqual(self.watch(self.body(ref="t2#5", name="Urgenty / Urgenty", kind="urgent"))[0], 200)
        status, hooks = self.admin.get("hooks")
        self.assertEqual(sorted((h["name"], h["kind"], h["watching"]) for h in hooks["hooks"]),
                         [("", "status", 1), ("Kooperace / List 1", "status", 2), ("Urgenty / Urgenty", "urgent", 2)])
        status, data = self.watch(method="GET", query="?ref=t2%235")
        self.assertEqual([s["name"] for s in data["sheets"]], ["Urgenty / Urgenty"])
        status, data = self.watch(method="DELETE", query="?ref=t2%235")
        self.assertEqual(data["count"], 1)
        status, data = self.watch(method="GET")
        self.assertEqual(len(data["sheets"]), 2)
        status, data = self.watch(self.body(kind="nic"))
        self.assertEqual(status, 400)
        status, data = self.watch(self.body(notes=["seznam"]))
        self.assertEqual(status, 400)
        for i in range(18):
            self.watch(self.body(ref=f"x{i}"))
        status, data = self.watch(self.body(ref="navic"))
        self.assertEqual((status, data["error"]), (409, "too_many_sheets"))
        status, data = self.watch(method="DELETE")
        self.assertEqual(data["count"], 20, "DELETE bez ref odpojí všechny tabulky klíče")

    def test_urgent_until_export(self):
        worker, _ = self.user("dvorak", depts=["hala", "elox"])
        self.watch(self.body(ref="u", kind="urgent", barcodes=["U-1", "U-2"], notes={"u-1": "expres"}))
        worker.dept("hala")
        status, data = worker.get("urgent")
        self.assertEqual((data["here"], data["counts"]), ([], {}), "urgent, který ještě nikde neleží, nesvítí")
        status, data = worker.scan("prijem", [{"barcode": "u-1"}, {"barcode": "JINA"}], position="R3")
        self.assertEqual([r.get("urgent") for r in data["results"]], [{"note": "expres"}, None])
        status, data = worker.get("urgent")
        self.assertEqual([(u["barcode"], u["note"], u["last"]["position"]) for u in data["here"]], [("u-1", "expres", "R3")])
        self.assertEqual(data["counts"], {"hala": 1})
        status, onsite = worker.get("onsite")
        self.assertEqual((sorted(onsite["urgent"]), onsite["urgentCounts"]), (["u-1"], {"hala": 1}))
        status, found = worker.get("search", q="U-1")
        self.assertEqual(found["exact"]["urgent"], "expres")
        # na jiném pracovišti nesvítí; Visitor nemá pracoviště
        worker.dept("elox")
        self.assertEqual(worker.get("urgent")[1]["here"], [])
        worker.dept("hala")
        worker.scan("export", [{"barcode": "U-1", "qty": 1}])
        status, data = worker.get("urgent")
        self.assertEqual((data["here"], data["counts"]), ([], {}), "po exportu urgent zhasne")
        status, data = worker.get("urgent", all="1")
        self.assertEqual(sorted((u["barcode"], u["last"]["action"] if u["last"] else None) for u in data["all"]), [("U-1", "export"), ("U-2", None)])
        # storno exportu: urgent zase svítí
        status, recent = worker.get("recent")
        worker.post("cancel", {"id": recent["records"][0]["id"]})
        self.assertEqual(len(worker.get("urgent")[1]["here"]), 1)
        # zrušený klíč: urgenty z jeho tabulek neplatí
        status, keys = self.admin.get("apikeys")
        self.admin.post("apikey_revoke", {"id": keys["keys"][0]["id"]})
        self.assertEqual(worker.get("urgent")[1]["here"], [])

    def test_urgent_subparts_of_assembly(self):
        worker, _ = self.user("dvorak", depts=["hala"])
        worker.dept("hala")
        self.watch(self.body(ref="u", kind="urgent", family=True, barcodes=["12345.678901.23456"], notes={"12345.678901.23456": "sestava"}))
        self.watch(self.body(ref="v", kind="urgent", barcodes=["55555.111111.22222"]))      # bez poddílů
        status, data = worker.scan("prijem", [{"barcode": "12345.678902.23411"}, {"barcode": "12345.678801.23456"},
                                              {"barcode": "12345.67890.23456"}, {"barcode": "55555.111199.22299"}, {"barcode": "12345.678901.23456"}], position="P1")
        self.assertEqual([r.get("urgent") for r in data["results"]], [
            {"note": "sestava", "of": "12345.678901.23456", "mask": "12345.6789xx.234xx"},   # poddíl: liší se poslední dvojčíslí
            None,                                                                           # jiné číslo před dvojčíslím
            None,                                                                           # jiný tvar
            None,                                                                           # tabulka bez poddílů
            {"note": "sestava"},                                                            # sestava sama
        ])
        status, data = worker.get("urgent")
        self.assertEqual(sorted((u["barcode"], u["of"]) for u in data["here"]),
                         [("12345.678901.23456", None), ("12345.678902.23411", "12345.678901.23456")])
        self.assertEqual(data["counts"], {"hala": 2})
        status, found = worker.get("search", q="12345.678902.23411")
        self.assertEqual((found["exact"]["urgent"], found["exact"]["urgentOf"]), ("sestava", "12345.678901.23456"))
        # sestava i s díly (rozbalovací seznam): vlastní stav a stav každého poddílu
        here = {u["barcode"]: u for u in data["here"]}
        self.assertEqual([p["barcode"] for p in here["12345.678902.23411"]["parts"]], ["12345.678901.23456", "12345.678902.23411"])
        worker.scan("export", [{"barcode": "12345.678901.23456", "qty": 1}])
        worker.scan("prijem", [{"barcode": "12345.678903.23412"}])
        status, data = worker.get("urgent", all="1")
        overview = {u["barcode"]: u for u in data["all"]}
        self.assertEqual(sorted(overview), ["12345.678901.23456", "55555.111111.22222"], "poddíly jsou v řádku sestavy, ne zvlášť")
        asm = overview["12345.678901.23456"]
        self.assertEqual((asm["last"]["action"], asm["family"], asm["mask"], asm["onsite"]), ("export", True, "12345.6789xx.234xx", 2))
        self.assertEqual([(p["barcode"], p["last"]["action"], p["last"]["position"]) for p in asm["parts"]],
                         [("12345.678902.23411", "prijem", "P1"), ("12345.678903.23412", "prijem", None)])
        self.assertEqual(overview["55555.111111.22222"]["parts"], [], "tabulka bez poddílů")
        self.assertEqual([u["barcode"] for u in data["all"]][0], "12345.678901.23456", "nahoře urgenty, které (nebo jejich díl) leží na pracovišti")
        # export poddílu: zhasne jen on
        worker.scan("export", [{"barcode": "12345.678902.23411", "qty": 1}])
        self.assertEqual([u["barcode"] for u in worker.get("urgent")[1]["here"]], ["12345.678903.23412"])
        status, hooks = self.admin.get("hooks")
        self.assertEqual(sorted((h["ref"], h["family"]) for h in hooks["hooks"]), [("u", True), ("v", False)])

    def test_part_info_from_status_sheet(self):
        link = "https://is.example/detail/1?activeBarcode=I-1&x=2"
        status, data = self.watch(self.body(ref="s", barcodes=["I-1", "I-2", "I-3"], info={
            "I-1": {"order": "OBJ-1", "ean": "8590000000017", "eanAssembly": "8590000000024", "index": "03", "link": link, "nic": "x"},
            "i-2": {"link": "javascript:alert(1)", "order": "  OBJ-2  "},
            "I-3": {"link": "https://is.example/a b\"><script>"},
        }))
        self.assertEqual(status, 200, data)
        self.admin.dept("hala")
        status, data = self.admin.scan("prijem", [{"barcode": "i-1"}, {"barcode": "I-2"}, {"barcode": "I-3"}, {"barcode": "JINA"}])
        self.assertEqual([r.get("info") for r in data["results"]], [
            {"order": "OBJ-1", "ean": "8590000000017", "eanAssembly": "8590000000024", "index": "03", "link": link},
            {"order": "OBJ-2"},          # odkaz javascript: se neuloží
            None,                        # neplatný odkaz a nic dalšího
            None,
        ])
        status, last = self.admin.get("last", barcode="I-1")
        self.assertEqual(last["info"]["order"], "OBJ-1")
        status, found = self.admin.get("search", q="I-1")
        self.assertEqual(found["exact"]["info"]["link"], link)
        status, found = self.admin.get("search", q="I-")
        self.assertEqual({m["barcode"]: (m["info"] or {}).get("order") for m in found["matches"]}, {"i-1": "OBJ-1", "I-2": "OBJ-2", "I-3": None})
        status, onsite = self.admin.get("onsite")
        hala = next(d for d in onsite["depts"] if d["code"] == "hala")
        self.assertEqual(sorted((r["barcode"], (r["info"] or {}).get("index")) for r in hala["records"]), [("I-2", None), ("I-3", None), ("JINA", None), ("i-1", "03")])
        # Přehled: hledání podle údajů z tabulky
        self.watch(self.body(ref="s2", barcodes=["J-1", "J-2"], info={"J-1": {"order": "OBJ-77", "ean": "8591111111111", "index": "07"},
                                                                       "J-2": {"order": "OBJ-77", "ean": "8592222222222", "eanAssembly": "8590000000099", "index": "08"}}))
        self.admin.scan("prijem", [{"barcode": "J-1"}, {"barcode": "J-2"}])
        status, found = self.admin.get("search", q="8592222222222")
        self.assertEqual((found["exact"]["barcode"], found["exact"]["via"], found["exact"]["info"]["order"]), ("J-2", "EAN dílu", "OBJ-77"), "EAN dílu = přesná shoda")
        status, found = self.admin.get("search", q="obj-77")
        self.assertIsNone(found["exact"], "objednávka se dvěma průvodkami: jen seznam")
        self.assertEqual(sorted((m["barcode"], m["matchedBy"]) for m in found["matches"]), [("J-1", "objednávka"), ("J-2", "objednávka")])
        status, found = self.admin.get("search", q="08")
        self.assertEqual((found["exact"]["barcode"], found["exact"]["via"]), ("J-2", "index"), "index jen přesně")
        status, found = self.admin.get("search", q="0000000099")
        self.assertEqual(found["exact"], None)
        self.assertEqual([(m["barcode"], m["matchedBy"]) for m in found["matches"]], [("J-2", "EAN sestavy")], "část EAN sestavy")
        status, found = self.admin.get("search", q="J-")
        self.assertIn("J-1", [m["barcode"] for m in found["matches"]], "hledání podle barcodu funguje dál")
        status, recent = self.admin.get("recent")
        self.assertEqual(next(r for r in recent["records"] if r["barcode"] == "J-1")["info"]["order"], "OBJ-77", "údaje i v posledních záznamech")
        status, data = self.watch(self.body(ref="s", info=["seznam"]))
        self.assertEqual(status, 400)
        # tabulka s urgenty: v buňce může být EAN vrcholné sestavy, údaje k průvodce se z ní neberou
        self.watch(self.body(ref="u", kind="urgent", barcodes=["I-1", "I-9"], info={"I-1": {"order": "Z-URGENTU", "ean": "999"}, "I-9": {"order": "Z-URGENTU"}}))
        self.assertEqual(self.admin.get("last", barcode="I-1")[1]["info"]["order"], "OBJ-1")
        self.assertIsNone(self.admin.get("last", barcode="I-9")[1]["info"])
        with self.server.db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM hook_watch w JOIN hooks h ON h.id = w.hook_id WHERE h.kind = 'urgent' AND w.info IS NOT NULL").fetchone()[0], 0)
        # odpojená tabulka: údaje zmizí
        self.watch(method="DELETE", query="?ref=s")
        self.assertIsNone(self.admin.get("last", barcode="I-1")[1]["info"])

    def test_big_list_with_info(self):
        codes = [f"12345.{100000 + i}.{20000 + i}" for i in range(10000)]
        info = {c: {"order": f"OBJ-{i}", "ean": f"859{i:010d}", "eanAssembly": f"858{i:010d}", "index": "01",
                    "link": f"https://is.example/commission.production.detail/default/{i}?activeBarcode={c}&componentProductionId={i}"} for i, c in enumerate(codes)}
        status, data = self.watch(self.body(ref="velka", barcodes=codes, info=info))
        self.assertEqual((status, data.get("watching")), (200, 10000), str(data)[:200])

    def test_upgrade_from_schema_3_keeps_sheet(self):
        self.server.stop()
        data = self.server.data
        with sqlite3.connect(data / "evidence.sqlite3") as db:
            db.execute("DROP TABLE hook_queue"); db.execute("DROP TABLE hook_watch"); db.execute("DROP TABLE hooks"); db.execute("DROP TABLE meta")
            db.executescript(V3_HOOKS)
            key_id = db.execute("SELECT id FROM api_keys").fetchone()[0]
            db.execute("INSERT INTO hooks (id, api_key_id, url, secret, watch_count, sent_count, created_at, updated_at) VALUES (7, ?, ?, ?, 2, 5, 1, 1)", (key_id, self.url, self.SECRET))
            db.execute("INSERT INTO hook_watch VALUES (7, 'A-1'), (7, 'A-2')")
            db.execute("INSERT INTO hook_queue VALUES (7, 'A-1', 3, 1)")
            db.execute("PRAGMA user_version = 3")
        self.server = Server(data, **self.SERVER_ENV)
        self.admin = Client(self.server)
        self.admin.login("spravce")
        status, hooks = self.admin.get("hooks")
        h = hooks["hooks"][0]
        self.assertEqual((h["id"], h["watching"], h["queued"], h["sent"], h["kind"], h["name"]), (7, 2, 1, 5, "status", ""))
        with self.server.db() as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 5)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM hook_watch").fetchone()[0], 2)
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])
        # skript 1.3 (bez ref) dál aktualizuje stejné propojení, nevznikne druhé
        status, data = self.watch(self.body(barcodes=["A-1"]))
        self.assertEqual(status, 200, data)
        status, hooks = self.admin.get("hooks")
        self.assertEqual([(h["id"], h["watching"]) for h in hooks["hooks"]], [(7, 1)])
        # cizí klíče po aktualizaci platí: odpojení smaže i sledované průvodky
        self.admin.post("hook_delete", {"id": 7})
        with self.server.db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM hook_watch").fetchone()[0], 0)


class DataTests(Base):
    def test_backup_rebuild_and_reopen_keep_data(self):
        self.admin.dept("hala")
        self.admin.scan("prijem", [{"barcode": f"B-{i}"} for i in range(30)], position="A1", define=True)
        self.admin.scan("export", [{"barcode": "B-1", "qty": 2}])
        with self.server.db() as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 5)
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
                self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 5)
                self.assertIn("pending_until", [r[1] for r in db.execute("PRAGMA table_info(users)")])
                tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
                self.assertTrue({"hooks", "hook_watch", "hook_queue", "meta"} <= tables, "schéma 3 (živé propojení)")
                self.assertIn("kind", [r[1] for r in db.execute("PRAGMA table_info(hooks)")], "schéma 4 (víc tabulek, urgenty)")
                self.assertIn("info", [r[1] for r in db.execute("PRAGMA table_info(hook_watch)")], "schéma 5 (údaje k průvodce)")
                self.assertEqual(db.execute("SELECT COUNT(*) FROM records").fetchone()[0], 2)
        finally:
            server.stop()
            shutil.rmtree(data, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
