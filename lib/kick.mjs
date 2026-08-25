export function createSocketHub() {
  const byUser = new Map();

  const forget = (userId, socket) => {
    if (byUser.get(userId)?.socket === socket) byUser.delete(userId);
  };

  return {
    add(userId, viewerId, workspaceId, socket, takeover) {
      const current = byUser.get(userId) || null;
      if (current && current.viewerId !== viewerId && !takeover) {
        return { accepted: false, previous: null };
      }
      byUser.set(userId, { viewerId, workspaceId, socket });
      socket.on("close", () => forget(userId, socket));
      return { accepted: true, previous: current };
    },
    drop(userId) {
      const current = byUser.get(userId);
      if (!current) return 0;
      byUser.delete(userId);
      current.socket.terminate();
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
