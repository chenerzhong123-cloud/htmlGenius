import sqlite3

from server import storage, teams


def _old_schema_db(path):
    """手建 OLD schema(google_sub 主键),灌入样本 Google 用户/团队/成员。"""
    c = sqlite3.connect(str(path))
    c.executescript(
        """
        CREATE TABLE users(google_sub TEXT PRIMARY KEY, email TEXT, name TEXT,
            picture TEXT, first_seen TEXT, last_seen TEXT);
        CREATE TABLE memberships(google_sub TEXT, team_id TEXT, joined_at TEXT, role TEXT,
            PRIMARY KEY(google_sub, team_id));
        CREATE TABLE teams(team_id TEXT PRIMARY KEY, name TEXT, created_by_sub TEXT, created_at TEXT);
        CREATE TABLE invites(code TEXT PRIMARY KEY, team_id TEXT, created_by_sub TEXT,
            created_at TEXT, max_uses INTEGER, used_count INTEGER, expires_at TEXT);
        """
    )
    c.execute("INSERT INTO users(google_sub,email,name) VALUES(?,?,?)", ("g_sub_1", "a@x.com", "Alice"))
    c.execute(
        "INSERT INTO teams(team_id,name,created_by_sub,created_at) VALUES(?,?,?,?)",
        ("team_t1", "T1", "g_sub_1", "2026-01-01T00:00:00+00:00"),
    )
    c.execute(
        "INSERT INTO memberships(google_sub,team_id,joined_at,role) VALUES(?,?,?,?)",
        ("g_sub_1", "team_t1", "2026-01-01T00:00:00+00:00", "owner"),
    )
    c.commit()
    c.close()


def test_migrates_old_schema_and_preserves_data(tmp_path):
    db = tmp_path / "old.db"
    _old_schema_db(db)
    storage.init_db(db)  # 触发迁移
    c = sqlite3.connect(str(db))
    c.row_factory = sqlite3.Row
    cols_users = {r["name"] for r in c.execute("PRAGMA table_info(users)")}
    assert "user_id" in cols_users and "google_sub" not in cols_users
    assert {"provider", "subject", "password_hash", "email_verified"} <= cols_users
    cols_mem = {r["name"] for r in c.execute("PRAGMA table_info(memberships)")}
    assert "user_id" in cols_mem and "google_sub" not in cols_mem
    assert "created_by" in {r["name"] for r in c.execute("PRAGMA table_info(teams)")}
    assert "created_by" in {r["name"] for r in c.execute("PRAGMA table_info(invites)")}
    # 数据未改写:Google 用户 user_id == 原 google_sub,provider=google,subject=user_id
    row = c.execute("SELECT user_id,provider,subject,email FROM users").fetchone()
    assert row["user_id"] == "g_sub_1" and row["provider"] == "google" and row["subject"] == "g_sub_1"
    # email_verifications 新表存在
    tables = {r["name"] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert "email_verifications" in tables
    c.close()


def test_migration_is_idempotent(tmp_path):
    db = tmp_path / "old.db"
    _old_schema_db(db)
    storage.init_db(db)
    storage.init_db(db)  # 再跑一次不报错、不丢数据
    c = sqlite3.connect(str(db))
    assert c.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 1
    c.close()


def test_fresh_install_has_new_schema(tmp_path):
    db = tmp_path / "fresh.db"
    storage.init_db(db)
    c = sqlite3.connect(str(db))
    c.row_factory = sqlite3.Row
    cols = {r["name"] for r in c.execute("PRAGMA table_info(users)")}
    assert "user_id" in cols and "provider" in cols and "google_sub" not in cols
    c.close()


def test_teams_work_after_migration(tmp_path, monkeypatch):
    monkeypatch.setenv("HG_LARK_APP_SECRET", "s")
    monkeypatch.setenv("HG_ENV", "test")
    db = tmp_path / "old.db"
    _old_schema_db(db)
    storage.init_db(db)
    # 老 Google 用户迁移后仍能查到自己的团队
    assert teams.user_teams("g_sub_1") == [{"team_id": "team_t1", "name": "T1"}]
    assert teams.member_role("g_sub_1", "team_t1") == "owner"
