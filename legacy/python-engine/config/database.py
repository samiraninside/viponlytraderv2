"""Database configuration and session management."""
from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, scoped_session, sessionmaker

from config.settings import ENGINE

# Initialize database engine
engine = create_engine(
    ENGINE.database_url,
    connect_args={"check_same_thread": False} if ENGINE.database_url.startswith("sqlite") else {},
    echo=False,
    future=True,
)

Session = scoped_session(sessionmaker(bind=engine, autoflush=False, autocommit=False))
Base = declarative_base()


def get_db():
    """Yield a database session and ensure it's closed properly."""
    db = Session()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    """Create all tables. Called once at startup."""
    from data import db_models  # noqa: F401  (import registers models on Base)
    Base.metadata.create_all(bind=engine)
