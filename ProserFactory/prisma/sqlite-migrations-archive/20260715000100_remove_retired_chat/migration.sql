-- Retire the chat tables that belonged to the removed API/worker application.
DROP TABLE IF EXISTS "chat_messages";
DROP TABLE IF EXISTS "chat_sessions";
