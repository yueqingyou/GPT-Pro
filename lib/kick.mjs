export function createSocketHub() {
  const byUser = new Map();

  const forget = (userId, socket) => {
    const set = byUser.get(userId);
    if (!set) return;
    set.delete(socket);
    if (!set.size) byUser.delete(userId);
  };

  return {
    add(userId, socket) {
      if (!byUser.has(userId)) byUser.set(userId, new Set());
      byUser.get(userId).add(socket);
      socket.on("close", () => forget(userId, socket));
    },
    drop(userId) {
      const set = byUser.get(userId);
      if (!set) return 0;
      const n = set.size;
      for (const socket of set) socket.terminate();
      byUser.delete(userId);
      return n;
    },
    count(userId) {
      return byUser.get(userId)?.size || 0;
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
