import sqlite3

def get_connection():
    return sqlite3.connect("caremate.db")

def create_tables():
    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute("""CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_name TEXT,
    transcript TEXT,
    summary TEXT,
    speaker_turns TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)""")

    cursor.execute("""CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    due_at TIMESTAMP,
    status TEXT NOT NULL DEFAULT 'pending',
    conversation_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(conversation_id) REFERENCES conversations(id))""")

    conn.commit()
    conn.close()
