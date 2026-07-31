-- Migration: table required by @socket.io/postgres-adapter, which fans socket.io
-- packets (rooms/broadcasts, e.g. admin-broadcast, session:<id>) out across
-- multiple server processes via Postgres NOTIFY/LISTEN + this table. Without it,
-- a blue-green deploy window with two app containers running briefly loses
-- events between sockets connected to different containers (rooms/relay break).
-- Date: 2026-07-30

CREATE TABLE IF NOT EXISTS socket_io_attachments (
    id          BIGSERIAL UNIQUE,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    payload     BYTEA
);

COMMENT ON TABLE socket_io_attachments IS 'Managed by @socket.io/postgres-adapter; rows are transient, safe to truncate';
