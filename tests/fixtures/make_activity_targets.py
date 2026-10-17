"""Generator for tests/fixtures/activity_targets.json (hermes 0.6.5,
Privacy amendment 4). Virtual absolute paths ("/...") in cwd, env HOME /
USERPROFILE, args.path and fs are mapped by the runner into a temp dir."""
import json
import sys

A = {"USER": "alice", "HOME": "/Users/alice"}
P = "/Users/alice/code/proj"
PFS = [P + "/.git/"]
VERB = {"read_file": "read", "write_file": "write", "patch": "edit",
        "search_files": "search", "terminal": "run"}
V = []


def v(name, tool, args, q, cwd=P, env=A, fs=PFS, line=None, key_distinct_from=None,
      system_user=None, system_home=None):
    if q is not None and line is None:
        line = VERB[tool] + " " + q
    case = {"name": name, "tool": tool, "args": args, "cwd": cwd, "env": env, "fs": fs,
            "expected_query": q, "expected_line": line if q is not None else None}
    if key_distinct_from:
        case["key_distinct_from"] = key_distinct_from
    if system_user:
        case["system_user"] = system_user
    if system_home:
        case["system_home"] = system_home
    V.append(case)


def rd(p):
    return {"path": p}


def run(c):
    return {"command": c}


def srch(pattern, path=None):
    out = {"pattern": pattern}
    if path is not None:
        out["path"] = path
    return out


# ---- P1: inside a project root, relative to it ----
v("P1: relative path in the project", "read_file", rd("src/billing/invoice.py"), "src/billing/invoice.py")
v("P1: absolute path in the project", "read_file", rd(P + "/src/x.py"), "src/x.py")
v("P1: relative to the root, not the cwd", "read_file", rd("x.py"), "src/x.py", cwd=P + "/src")
v("P1: ./ prefix", "write_file", {"path": "./a/b.py", "content": "SECRET"}, "a/b.py")
v("P1: backslashes", "patch", {"path": "a\\b\\c.py", "old_string": "o", "new_string": "SECRET"}, "a/b/c.py")
v("P1: .. inside the project", "read_file", rd("src/../README.md"), "README.md")
v("P1: ~ path inside the project", "read_file", rd("~/code/proj/src/x.py"), "src/x.py")
v("P1: the root itself is no query", "read_file", rd("./"), None)
v("P1: every marker counts: pyproject.toml", "read_file", rd("src/a.py"), "src/a.py", cwd="/srv/py", fs=["/srv/py/pyproject.toml"])
v("P1: every marker counts: package.json", "read_file", rd("src/a.ts"), "src/a.ts", cwd="/srv/js", fs=["/srv/js/package.json"])
v("P1: every marker counts: Cargo.toml", "read_file", rd("src/main.rs"), "src/main.rs", cwd="/srv/rs", fs=["/srv/rs/Cargo.toml"])
v("P1: every marker counts: go.mod", "read_file", rd("main.go"), "main.go", cwd="/srv/go", fs=["/srv/go/go.mod"])
v("P1: every marker counts: pom.xml", "read_file", rd("src/A.java"), "src/A.java", cwd="/srv/jv", fs=["/srv/jv/pom.xml"])
v("P1: every marker counts: build.gradle", "read_file", rd("app/B.kt"), "app/B.kt", cwd="/srv/kt", fs=["/srv/kt/build.gradle"])
v("P1: every marker counts: Gemfile", "read_file", rd("lib/c.rb"), "lib/c.rb", cwd="/srv/rb", fs=["/srv/rb/Gemfile"])
v("P1: every marker counts: composer.json", "read_file", rd("src/d.php"), "src/d.php", cwd="/srv/php", fs=["/srv/php/composer.json"])
v("P1: every marker counts: *.sln", "read_file", rd("App/e.cs"), "App/e.cs", cwd="/srv/cs", fs=["/srv/cs/App.sln"])
v("P1: every marker counts: .hg", "read_file", rd("f.py"), "f.py", cwd="/srv/hg", fs=["/srv/hg/.hg/"])
v("P1: every marker counts: .git file (worktree)", "read_file", rd("g.py"), "g.py", cwd="/srv/wt", fs=["/srv/wt/.git"])
v("P1: every marker counts: .curated-thoughts-project", "read_file", rd("notes/h.md"), "notes/h.md", cwd="/srv/ct", fs=["/srv/ct/.curated-thoughts-project"])
# ---- P1: everything else gives no query ----
v("P1: absolute path outside the project", "read_file", rd("/Users/alice/notes.txt"), None)
v("P1: another project is outside", "read_file", rd("/Users/alice/code/other/y.py"), None, fs=PFS + ["/Users/alice/code/other/.git/"])
v("P1: ~ path outside the project", "read_file", rd("~/notes/z.md"), None)
v("P1: bare ~", "read_file", rd("~"), None)
v("P1: ~user path", "read_file", rd("~bob/notes/z.md"), None)
v("P1: .. climbing out", "read_file", rd("../../bob/secret.txt"), None)
v("P1: .. to a sibling", "read_file", rd("../other/x.py"), None)
v("P1: no cwd", "read_file", rd("src/x.py"), None, cwd="")
v("P1: relative cwd", "read_file", rd("src/x.py"), None, cwd="code/proj")
v("P1: no project root", "read_file", rd("/work/repo/src/x.py"), None, cwd="/work/repo", fs=[])
v("P1: cwd / (old bug 1)", "read_file", rd("/Users/alice/clients/acme/contract.md"), None, cwd="/")
v("P1: cwd = HOME", "read_file", rd("/Users/alice/clients/acme/contract.md"), None, cwd="/Users/alice")
v("P1: cwd /Users", "read_file", rd("/Users/alice/clients/acme/contract.md"), None, cwd="/Users")
# ---- markers at HOME or above are ignored ----
v("P1: dotfiles repo at HOME is not a root", "read_file", rd("/Users/alice/notes/todo.md"), None, cwd="/Users/alice/notes", fs=["/Users/alice/.git/"])
v("P1: marker above HOME is not a root", "read_file", rd("/Users/alice/x/y.md"), None, cwd="/Users/alice/x", fs=["/Users/package.json"])
v("P1: marker at a top-level dir is not a root", "read_file", rd("/home/bob/secret.txt"), None, cwd="/home/bob", env={"USER": "carl", "HOME": "/home/carl"}, fs=["/home/package.json"])
v("P1: project inside HOME under a dotfiles repo", "read_file", rd("src/a.py"), "src/a.py", fs=["/Users/alice/.git/", P + "/.git/"])
# ---- HOME=/ family (nobody, daemon, containers) ----
for d in ("/home", "/var/home", "/nfs/home", "/export/home"):
    v("HOME=/: cwd " + d, "read_file", rd(d + "/bob/secret.txt"), None, cwd=d, env={"USER": "nobody", "HOME": "/"}, fs=[])
    v("HOME=/: cwd %s/bob" % d, "read_file", rd(d + "/bob/acme/secret.txt"), None, cwd=d + "/bob", env={"USER": "nobody", "HOME": "/"}, fs=[])
v("HOME=/: a marker at /home is not a root", "read_file", rd("/home/bob/secret.txt"), None, cwd="/home/bob", env={"USER": "nobody", "HOME": "/"}, fs=["/home/package.json"])
v("HOME=/: a marker at /srv is a root", "read_file", rd("/srv/app/x.py"), "app/x.py", cwd="/srv/app", env={"USER": "nobody", "HOME": "/"}, fs=["/srv/.git/"])
v("no HOME: a marker at /Users is not a root", "read_file", rd("/Users/bob/x.md"), None, cwd="/Users/bob", env={"USER": "carl"}, fs=["/Users/package.json"])
v("HOME=/: a real project still works", "read_file", rd("/srv/app/src/x.py"), "src/x.py", cwd="/srv/app", env={"USER": "nobody", "HOME": "/"}, fs=["/srv/app/pyproject.toml"])
v("HOME=/root: project under it", "read_file", rd("src/root/x.py"), "src/root/x.py", cwd="/root/app", env={"USER": "root", "HOME": "/root"}, fs=["/root/app/.git/"])
# ---- WSL ----
W = {"USER": "alice", "HOME": "/home/alice"}
v("WSL: cwd /mnt/c/Users", "read_file", rd("/mnt/c/Users/Bob/secret.txt"), None, cwd="/mnt/c/Users", env=W, fs=[])
v("WSL: cwd /mnt/c", "read_file", rd("/mnt/c/Users/Bob/secret.txt"), None, cwd="/mnt/c", env=W, fs=[])
v("WSL: project on the Windows drive", "read_file", rd("/mnt/c/dev/proj/src/a.py"), "src/a.py", cwd="/mnt/c/dev/proj", env=W, fs=["/mnt/c/dev/proj/.git/"])
# ---- nested repos: the nearest root wins ----
NFS = ["/srv/mono/.git/", "/srv/mono/packages/app/package.json"]
v("nested: nearest root", "read_file", rd("/srv/mono/packages/app/src/x.ts"), "src/x.ts", cwd="/srv/mono/packages/app/src", fs=NFS)
v("nested: outer file is outside the nearest root", "read_file", rd("/srv/mono/README.md"), None, cwd="/srv/mono/packages/app", fs=NFS)
v("nested: outer root from the outer cwd", "read_file", rd("../packages/app/src/x.ts"), "packages/app/src/x.ts", cwd="/srv/mono/docs", fs=NFS)
# ---- symlinks ----
SFS = ["/srv/real/.git/", {"symlink": "/srv/link", "to": "/srv/real"}]
v("symlink: cwd through a link", "read_file", rd("/srv/link/src/a.py"), "src/a.py", cwd="/srv/link", fs=SFS)
v("symlink: relative path from a linked cwd", "read_file", rd("src/b.py"), "src/b.py", cwd="/srv/link", fs=SFS)
v("symlink: a link escaping the project", "read_file", rd("escape/x.md"), None, cwd="/srv/real",
  fs=["/srv/real/.git/", "/Users/alice/private/", {"symlink": "/srv/real/escape", "to": "/Users/alice/private"}])
# ---- case and NFC folding ----
v("fold: NFD path under an NFC root", "read_file", rd("/srv/caf\u00e9/docs/a.md".replace("caf\u00e9", "cafe\u0301")), "docs/a.md", cwd="/srv/caf\u00e9", fs=["/srv/caf\u00e9/.git/"])
# ---- Windows and colon forms never resolve ----
WE = {"USERNAME": "carol", "USERPROFILE": "C:\\Users\\carol"}
for name, raw in (("drive path", "C:\\Users\\carol\\proj\\a.py"), ("drive-relative", "C:foo.md"),
                  ("drive-relative ..", "C:..\\Users\\alice\\x.md"), ("\\\\?\\ prefix", "\\\\?\\C:\\"),
                  ("/C:/", "/C:/"), ("/mnt/c:", "/mnt/c:"), ("UNC", "\\\\server\\share\\x.txt"),
                  ("rooted backslash", "\\etc\\passwd"), ("colon component", "docs/foo:bar/x.md")):
    v("win: %s gives nothing" % name, "read_file", rd(raw), None, env=WE)
# ---- P2: names ----
v("P2: user name in a relative path", "read_file", rd("alice/drafts/plan.md"), None)
v("P2: user name in a file name", "read_file", rd("notes/alice.txt"), None)
v("P2: user name case-insensitive", "read_file", rd("Alice/plan.md"), None)
v("P2: user name NFD", "read_file", rd("docs/jose\u0301_plan.md"), None, cwd="/srv/p", env={"USER": "jos\u00e9"}, fs=["/srv/p/.git/"])
v("P2: substring hit (sample / sam)", "read_file", rd("src/sample.py"), None, cwd="/srv/p", env={"USER": "sam"}, fs=["/srv/p/.git/"])
v("P2: LOGNAME", "read_file", rd("dave/x.md"), None, cwd="/srv/p", env={"LOGNAME": "dave"}, fs=["/srv/p/.git/"])
v("P2: USERNAME", "read_file", rd("carol-notes.md"), None, cwd="/srv/p", env=WE, fs=["/srv/p/.git/"])
v("P2: HOME basename under a home dir", "read_file", rd("alice-notes.md"), None, cwd="/nfs/home/alice/proj", env={"HOME": "/nfs/home/alice"}, fs=["/nfs/home/alice/proj/.git/"])
v("P2: HOME basename under /nfs/home with no USER", "read_file", rd("src/alice.py"), None, cwd="/nfs/home/alice/proj", env={"HOME": "/nfs/home/alice"}, fs=["/nfs/home/alice/proj/.git/"])
v("P2: USERPROFILE basename under Profiles", "read_file", rd("erin/x.md"), None, cwd="/srv/p", env={"USERPROFILE": "D:\\Profiles\\erin"}, fs=["/srv/p/.git/"])
v("P2: multi-word name, exact", "read_file", rd("docs/John Smith notes.md"), None, cwd="/srv/p", env={"USERNAME": "John Smith"}, fs=["/srv/p/.git/"])
v("P2: multi-word name, joined", "read_file", rd("docs/john_smith.md"), None, cwd="/srv/p", env={"USERNAME": "John Smith"}, fs=["/srv/p/.git/"])
v("P2: multi-word name, unrelated file", "read_file", rd("docs/plan.md"), "docs/plan.md", cwd="/srv/p", env={"USERNAME": "John Smith"}, fs=["/srv/p/.git/"])
v("P2: short name as a component", "read_file", rd("jo/notes.md"), None, cwd="/srv/p", env={"USER": "jo"}, fs=["/srv/p/.git/"])
v("P2: short name as a token (jo.md)", "read_file", rd("docs/jo.md"), None, cwd="/srv/p", env={"USER": "jo"}, fs=["/srv/p/.git/"])
v("P2: short name as a token (jo-notes)", "read_file", rd("jo-notes/x.md"), None, cwd="/srv/p", env={"USER": "jo"}, fs=["/srv/p/.git/"])
v("P2: short name inside a word is fine", "read_file", rd("src/join.py"), "src/join.py", cwd="/srv/p", env={"USER": "jo"}, fs=["/srv/p/.git/"])
v("P2: service account USER is not private", "read_file", rd("src/root/x.py"), "src/root/x.py", cwd="/srv/p", env={"USER": "root", "HOME": "/root"}, fs=["/srv/p/.git/"])
v("P2: home not a name is kept", "read_file", rd("home/plan.md"), "home/plan.md")
v("P2: unicode file name", "read_file", rd("docs/a\u00f1o.md"), "docs/a\u00f1o.md")
v("P2: the project dir name is never sent", "read_file", rd("/Users/alice/code/alice-site/index.md"), "index.md", cwd="/Users/alice/code/alice-site", fs=["/Users/alice/code/alice-site/.git/"])
# ---- keys ----
v("key: README in project a", "read_file", rd("README.md"), "README.md", cwd="/srv/a", fs=["/srv/a/.git/"])
v("key: README in project b", "read_file", rd("README.md"), "README.md", cwd="/srv/b", fs=["/srv/b/.git/"], key_distinct_from="key: README in project a")
# ---- P4: search ----
v("search: pattern only needs no project", "search_files", srch("TODO"), "TODO", cwd="", fs=[])
v("search: path inside the project", "search_files", srch("MCP tool name", "src"), "MCP tool name", line="search MCP tool name in src")
v("search: path outside the project is dropped", "search_files", srch("TODO", "/Users/alice/clients/acme"), "TODO", line="search TODO")
v("search: path naming the user gives nothing", "search_files", srch("TODO", "alice-notes"), None)
v("search: user name in the pattern", "search_files", srch("alice TODO"), None)
v("search: user name inside a word", "search_files", srch("alice_notes TODO"), None)
v("search: substring name (samples / sam)", "search_files", srch("TODO samples"), None, env={"USER": "sam"})
v("search: short name word", "search_files", srch("jo TODO"), None, env={"USER": "jo"})
v("search: short name inside a word is fine", "search_files", srch("join TODO"), "join TODO", env={"USER": "jo"})
v("search: multi-word name", "search_files", srch("john smith notes"), None, env={"USERNAME": "John Smith"})
for name, pat in (("quoted assignment", 'API_KEY="hunter2pass"'), ("assignment", "password=letmein"),
                  ("colon value", "password:letmein"), ("colon-space value", "token: hunter2"),
                  ("flag value", "--password hunter2"), ("bearer", "Bearer abc123xyz"),
                  ("auth word", "find the secret word"), ("apikey", "load APIKEY here"),
                  ("dash word", "-v hunter2"), ("email", "bob@example.com"),
                  ("rooted backslash", "\\ProgramData\\corp\\secrets.txt"), ("slash", "src/billing"),
                  ("regex", "def \\w+_target"), ("quote", "it's broken"), ("backtick", "`whoami`"),
                  ("credential-shaped", "token a1b2c3d4e5f6g7h8i9"), ("key prefix", "find ghp_abcdefghijklmnop1234 here"),
                  ("7 words", "one two three four five six seven"), ("81 chars", "x" * 81),
                  ("punctuation", "foo(bar)")):
    v("search: %s gives nothing" % name, "search_files", srch(pat), None)
v("search: 6 words", "search_files", srch("one two three four five six"), "one two three four five six")
v("search: 80 chars", "search_files", srch("x" * 80), "x" * 80)
v("search: dots and dashes", "search_files", srch("ct_wisdom.py fail-closed"), "ct_wisdom.py fail-closed")
v("search: unicode letters", "search_files", srch("a\u00f1o fiscal"), "a\u00f1o fiscal")
v("search: error 404", "search_files", srch("error 404"), "error 404")
# ---- P3: commands (Privacy amendment 5: program allowlist) ----
for name, cmd, q in (
        # known subcommand tools + a known verb
        ("pnpm test", "pnpm test", "pnpm test"), ("npm run", "npm run build", "npm run"),
        ("npm run-script", "npm run-script lint", "npm run-script"), ("git rebase", "git rebase -i main", "git rebase"),
        ("git commit quoted", "git commit -m 'msg SECRET'", "git commit"), ("cargo clippy", "cargo clippy --fix", "cargo clippy"),
        ("docker compose", "docker compose up -d", "docker compose"), ("kubectl get", "kubectl get pods", "kubectl get"),
        ("terraform plan", "terraform plan -out x", "terraform plan"), ("go test", "go test ./...", "go test"),
        ("gh pr", "gh pr create", "gh pr"), ("uv run", "uv run pytest", "uv run"),
        ("make test", "make test", "make test"), ("just fmt", "just fmt", "just fmt"), ("rake build", "rake build", "rake build"),
        # known tool, unknown or non-verb next word: the program alone
        ("git unknown verb", "git frobnicate", "git"), ("git flag first", "git -C somedir status", "git"),
        ("make uncommon target", "make deploy-prod", "make"), ("make capitalized", "make Build", "make"),
        ("rake path target", "rake db/migrate", "rake"), ("npm file", "npm acme.tgz", "npm"),
        # every other program: alone, whatever follows (0.6.5 sent these words)
        ("rm", "rm divorce-papers", "rm"), ("less", "less medical-records", "less"), ("cd", "cd acme-merger", "cd"),
        ("cat", "cat contract", "cat"), ("mkdir", "mkdir clients", "mkdir"), ("cp", "cp a b", "cp"), ("mv", "mv x y", "mv"),
        ("vim", "vim notes", "vim"), ("npx", "npx create-app", "npx"), ("pytest", "pytest tests/billing -q", "pytest"),
        ("cat dotfile", "cat .env.local | grep KEY", "cat"), ("curl", "curl -H 'A: b' https://h", "curl"),
        ("echo", "echo sk-live-abcdef", "echo"), ("psql flag value", "psql -W secretpw", "psql"),
        ("env assignment skipped", "API_KEY=sk-123 python deploy.py --token x", "python"),
        ("credential-shaped word", "deploy ghp_abcdefghijklmnop1234", "deploy"),
        ("cat under another home", "cat Bob/secret.txt", "cat"),
        # python -m: known modules
        ("python -m pytest", "python -m pytest -q", "python pytest"), ("python3 -m http.server", "python3 -m http.server 8000", "python3 http.server"),
        ("python3.11 -m pip", "python3.11 -m pip install x", "python3.11 pip"),
        ("python -m unknown module", "python -m acme_secret_tool", "python"),
        ("python -m quoted module", "python -m 'secretmod'", "python"), ("python -m capitalized module", "python -m MyPkg", "python"),
        ("python script", "python deploy.py", "python")):
    v("cmd: " + name, "terminal", run(cmd), q)
v("cmd: python -m a project package", "terminal", run("python -m mypkg.cli --key v"), "python mypkg.cli", fs=PFS + [P + "/mypkg/__init__.py"])
v("cmd: python -m a src-layout package", "terminal", run("python -m app"), "python app", fs=PFS + [P + "/src/app/__init__.py"])
v("cmd: python -m a module file in the project", "terminal", run("python -m tool"), "python tool", fs=PFS + [P + "/tool.py"])
v("cmd: python -m a package outside the project", "terminal", run("python -m mypkg"), "python", cwd="/srv/none", fs=["/srv/mypkg/__init__.py"])
# scripts and paths as the program: no query at all
for name, cmd in (("./script", "./acme_export.sh"), ("absolute script", "/opt/tools/acme_export.sh --all"),
                  ("bare script name", "acme_export.sh"), ("python file as program", "deploy.py"),
                  ("../bin", "../bin/run"), ("~ path", "~/bin/tool x"), ("Windows path", "C:\\tools\\x.exe"),
                  ("absolute python", "/usr/local/bin/python3 -m pytest"), ("absolute program", "/Users/alice/bin/deploy --token x"),
                  ("program with odd chars", "f(x) now"), ("program starting with a dot", ".hidden run")):
    v("cmd: %s gives nothing" % name, "terminal", run(cmd), None)
for name, cmd, env, q in (("user name subcommand", "finger alice", A, "finger"),
                          ("user name git subcommand", "git alice", A, "git"),
                          ("user name python module", "python -m alice_tools", A, "python"),
                          ("short name subcommand", "finger jo", {"USER": "jo"}, "finger"),
                          ("short name token", "cat jo.md", {"USER": "jo"}, "cat"),
                          ("service USER=node", "node server.js", {"USER": "node", "HOME": "/home/node"}, "node"),
                          ("service USER=test", "npm test", {"USER": "test", "HOME": "/home/test"}, "npm test"),
                          ("service USER=docker", "docker build", {"USER": "docker"}, "docker build")):
    v("cmd: " + name, "terminal", run(cmd), q, env=env)
for name, cmd in (("user name program", "alice --help"), ("user name inside the program", "alice-deploy now")):
    v("cmd: %s gives nothing" % name, "terminal", run(cmd), None)
v("cmd: a file under another user's home is never sent", "terminal", run("cat Bob/secret.txt"), "cat",
  cwd="/mnt/c/Users", env={"USER": "alice", "HOME": "/home/alice"}, fs=[])

# ---- review of PR #61 ----
# 1: home dirs come from HOME, USERPROFILE, expanduser("~") and pw_dir
v("home: HOME unset, dotfiles .git at the system home", "read_file", rd("/Users/alice/notes/todo.md"), None,
  cwd="/Users/alice/notes", env={"USER": "alice"}, fs=["/Users/alice/.git/"], system_home="/Users/alice")
v("home: USERPROFILE is a home even when HOME is set", "read_file", rd("/Users/carol/notes/todo.md"), None,
  cwd="/Users/carol/notes", env={"HOME": "/opt/x", "USERPROFILE": "/Users/carol"}, fs=["/Users/carol/.git/"])
v("home: a project inside the system home works", "read_file", rd("src/a.py"), "src/a.py",
  cwd="/Users/alice/code/proj", env={"USER": "alice"}, fs=["/Users/alice/.git/", P + "/.git/"], system_home="/Users/alice")
# 2: children of a homes dir, and /mnt/<letter>[/Users], are never roots
SVC = {"USER": "svc", "HOME": "/opt/svc"}
v("homes: another user's home with a package.json", "read_file", rd("/Users/Alice/docs/a.md"), None,
  cwd="/Users/Alice/docs", env=SVC, fs=["/Users/Alice/package.json"])
v("homes: /data/home/<x> with a marker", "read_file", rd("/data/home/bob/a.md"), None,
  cwd="/data/home/bob", env=SVC, fs=["/data/home/bob/.git/"])
v("homes: /Profiles/<x> with a marker", "read_file", rd("/Profiles/erin/a.md"), None,
  cwd="/Profiles/erin", env=SVC, fs=["/Profiles/erin/package.json"])
v("homes: a project below a user's home works", "read_file", rd("src/a.py"), "src/a.py",
  cwd="/Users/Alice/code/proj", env=SVC, fs=["/Users/Alice/package.json", "/Users/Alice/code/proj/.git/"])
v("WSL: /mnt/c with a marker", "read_file", rd("/mnt/c/dev/a.md"), None,
  cwd="/mnt/c/dev", env=W, fs=["/mnt/c/package.json"])
v("WSL: /mnt/c/Users with a marker", "read_file", rd("/mnt/c/Users/Bob/s.txt"), None,
  cwd="/mnt/c/Users", env=W, fs=["/mnt/c/Users/package.json"])
v("WSL: /mnt/d with a marker", "read_file", rd("/mnt/d/x/a.md"), None,
  cwd="/mnt/d/x", env=W, fs=["/mnt/d/.git/"])
# 4: HOME/USERPROFILE/pw_dir basenames are names only under Users/home/Profiles
v("names: HOME=/config does not make config private", "read_file", rd("config/app.yml"), "config/app.yml",
  cwd="/srv/app", env={"USER": "ci", "HOME": "/config"}, fs=["/srv/app/.git/"])
v("names: HOME=/github/home does not make home private", "read_file", rd("home/plan.md"), "home/plan.md",
  cwd="/srv/app", env={"USER": "runner", "HOME": "/github/home"}, fs=["/srv/app/.git/"])
v("names: HOME=/opt/app-root/src does not make src private", "read_file", rd("src/main.py"), "src/main.py",
  cwd="/srv/app", env={"HOME": "/opt/app-root/src"}, fs=["/srv/app/.git/"])
v("names: pw_name counts with no USER", "read_file", rd("alice/x.md"), None,
  cwd="/srv/app", env={}, fs=["/srv/app/.git/"], system_user="alice")
v("names: pw_dir basename under /home counts", "read_file", rd("zed-notes.md"), None,
  cwd="/srv/app", env={}, fs=["/srv/app/.git/"], system_home="/home/zed")
# 6: search keys with an out-of-root path stay distinct
v("key: search path a outside the root", "search_files", srch("TODO", "/Users/alice/clients/a"), "TODO", line="search TODO")
v("key: search path b outside the root", "search_files", srch("TODO", "/Users/alice/clients/b"), "TODO", line="search TODO",
  key_distinct_from="key: search path a outside the root")
# 7: tokens split on any non-alphanumeric (en dash, curly quote, x, /)
for name, raw in (("en dash", "docs/jo\u2013notes.md"), ("curly quote", "docs/jo\u2019s.md"),
                  ("times sign", "docs/jo\u00d72.md"), ("division sign", "docs/jo\u00f7x.md")):
    v("P2: short name split by " + name, "read_file", rd(raw), None, cwd="/srv/p", env={"USER": "jo"}, fs=["/srv/p/.git/"])

# ---- second review of PR #61 ----
# 2: a target over TARGET_CHARS (200) is not sent (never cut mid-token)
v("long: a path over 200 chars gives nothing", "read_file", rd("d/" * 100 + "f.py"), None)
v("long: a path of 199 chars is sent", "read_file", rd("a" * 196 + ".py"), "a" * 196 + ".py")
# 4: only known homes locations make a homes-dir child
for name, d in (("/var/home", "/var/home/bob"), ("/nfs/home", "/nfs/home/bob"), ("/export/home", "/export/home/bob"),
                ("/mnt/c/Users", "/mnt/c/Users/Bob")):
    v("homes: %s/<x> with a marker" % name, "read_file", rd(d + "/a.md"), None, cwd=d, env=SVC, fs=[d + "/package.json"])
v("homes: a project's own home/ folder is fine", "read_file", rd("Nav.tsx"), "src/pages/home/components/Nav.tsx",
  cwd="/srv/web/src/pages/home/components", env=SVC, fs=["/srv/web/package.json"])
v("homes: x/home/<y> is not a homes dir", "read_file", rd("/srv/x/home/bob/a.md"), "a.md",
  cwd="/srv/x/home/bob", env=SVC, fs=["/srv/x/home/bob/.git/"])
# 5: direct children of / can be roots, except homes locations and /mnt
v("root-level: /app container", "read_file", rd("/app/src/x.py"), "src/x.py", cwd="/app", env=SVC, fs=["/app/.git/"])
v("root-level: /workspace container", "read_file", rd("lib/y.ts"), "lib/y.ts", cwd="/workspace", env={"USER": "node", "HOME": "/home/node"}, fs=["/workspace/package.json"])
v("root-level: /home is never a root", "read_file", rd("/home/x.md"), None, cwd="/home", env=SVC, fs=["/home/.git/"])
v("root-level: /mnt is never a root", "read_file", rd("/mnt/x/a.md"), None, cwd="/mnt/x", env=SVC, fs=["/mnt/.git/"])
v("root-level: / is never a root", "read_file", rd("/x/a.md"), None, cwd="/x", env=SVC, fs=["/.git/"])

# ---- final review of PR #61: a found root is re-checked in realpath form ----
BOB = {"USER": "bob", "HOME": "/Users/bob"}
v("realpath: cwd symlink into HOME", "read_file", rd("Documents/taxes.pdf"), None, cwd="/work/link", env=BOB,
  fs=["/Users/bob/.git/", "/Users/bob/Documents/", {"symlink": "/work/link", "to": "/Users/bob"}])
v("realpath: cwd symlink to an ancestor of HOME", "read_file", rd("alice/notes.md"), None, cwd="/work/up",
  env={"USER": "svc", "HOME": "/data/u/alice"}, system_home="/data/u/alice",
  fs=["/data/u/.git/", "/data/u/alice/", {"symlink": "/work/up", "to": "/data/u"}])
v("realpath: cwd symlink to a homes location", "read_file", rd("carol/notes.md"), None, cwd="/work/all",
  env=SVC, fs=["/Users/package.json", "/Users/carol/", {"symlink": "/work/all", "to": "/Users"}])
v("realpath: macOS firmlink-style alias of HOME", "read_file", rd("Documents/taxes.pdf"), None,
  cwd="/System/Volumes/Data/Users/bob", env=BOB,
  fs=["/Users/bob/.git/", "/Users/bob/Documents/", {"symlink": "/System/Volumes/Data", "to": "/"}])
v("realpath: symlink into a project inside HOME is fine", "read_file", rd("src/a.py"), "src/a.py", cwd="/work/p", env=BOB,
  fs=["/Users/bob/.git/", "/Users/bob/code/proj/.git/", {"symlink": "/work/p", "to": "/Users/bob/code/proj"}])

# ---- 0.6.6: a HOME that is not a real user home blocks only itself ----
v("sandbox HOME inside the project", "read_file", rd("src/x.py"), "src/x.py", cwd="/srv/repo",
  env={"USER": "svc", "HOME": "/srv/repo/.home"}, fs=["/srv/repo/.git/"])
v("sandbox HOME is still never a root", "read_file", rd("/srv/repo/.home/x/a.md"), None, cwd="/srv/repo/.home/x",
  env={"USER": "svc", "HOME": "/srv/repo/.home"}, fs=["/srv/repo/.git/", "/srv/repo/.home/.git/"])
v("pw_dir outside a homes location still blocks its ancestors", "read_file", rd("svc/notes.md"), None, cwd="/opt",
  env={"USER": "ci"}, fs=["/opt/.git/", "/opt/svc/"], system_home="/opt/svc")

names = [c["name"] for c in V]
assert len(names) == len(set(names)), [n for n in names if names.count(n) > 1]
with open(sys.argv[1], "w", encoding="utf-8") as fh:
    json.dump(V, fh, indent=1, ensure_ascii=False)
    fh.write("\n")
print(len(V))
