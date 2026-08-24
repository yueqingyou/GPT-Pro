export function createSocketHub() {
  const byUser = new Map();

  const forget = (userId, socket) => {
    if (byUser.get(userId) === socket) byUser.delete(userId);
  };

  return {
    add(userId, socket) {
      const previous = byUser.get(userId) || null;
      byUser.set(userId, socket);
      socket.on("close", () => forget(userId, socket));
      return previous;
    },
    drop(userId) {
      const socket = byUser.get(userId);
      if (!socket) return 0;
      byUser.delete(userId);
      socket.terminate();
      return 1;
    },
  };
}

export function kickLiveSession({ sessions, sockets }, userId) {
  const id = String(userId || "");
  if (!id) return { sessions: 0, sockets: 0 };
  const droppedSessions = sessions.deleteByUser(id);
  const droppedSockets = sockets.drop(id);
  return { sessions: droppedSessions, sockets: droppedSockets };
}
