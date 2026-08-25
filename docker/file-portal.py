#!/usr/bin/python3
import json
import os
import pathlib
import re
import select
import socket
import threading
import time
import uuid

import dbus
import dbus.service
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib
from Xlib import X, display, error

BACKEND_NAME = "org.freedesktop.impl.portal.desktop.gpc"
GTK_BACKEND_NAME = "org.freedesktop.impl.portal.desktop.gtk"
PORTAL_PATH = "/org/freedesktop/portal/desktop"
FILE_CHOOSER_INTERFACE = "org.freedesktop.impl.portal.FileChooser"
REQUEST_INTERFACE = "org.freedesktop.impl.portal.Request"
GATEWAY_SOCKET = "/run/gpc/gateway.sock"
DESKTOP_SOCKET = "/run/gpc/desktop.sock"
UPLOAD_ROOT = "/transfer/uploads"
MAX_MESSAGE_BYTES = 64 * 1024
WORKSPACE_ID_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$")
PARENT_RE = re.compile(r"^x11:0x([0-9a-fA-F]+)$")


def empty_results():
    return dbus.Dictionary({}, signature="sv")


class WindowRouter:
    def __init__(self):
        self.lock = threading.Lock()

    @staticmethod
    def _text(window, atom):
        value = window.get_full_property(atom, X.AnyPropertyType)
        if not value:
            return ""
        raw = value.value
        if isinstance(raw, str):
            return raw
        return bytes(raw).decode("utf-8", "strict").rstrip("\0")

    @staticmethod
    def _windows(connection):
        root = connection.screen().root
        client_list = connection.intern_atom("_NET_CLIENT_LIST")
        value = root.get_full_property(client_list, X.AnyPropertyType)
        return [
            connection.create_resource_object("window", int(xid))
            for xid in (value.value if value else [])
        ]

    @staticmethod
    def _is_chromium(window):
        window_class = window.get_wm_class()
        return bool(window_class and window_class[-1] == "Chromium")

    @staticmethod
    def _set(connection, window, atom, value):
        utf8 = connection.intern_atom("UTF8_STRING")
        window.change_property(atom, utf8, 8, value.encode("utf-8"), X.PropModeReplace)

    def _window_with_title(self, connection, title):
        deadline = time.monotonic() + 2
        root = connection.screen().root
        root.change_attributes(event_mask=X.SubstructureNotifyMask)
        while True:
            windows = self._windows(connection)
            for window in windows:
                window.change_attributes(event_mask=X.PropertyChangeMask)
            connection.sync()
            matches = [
                window
                for window in windows
                if self._is_chromium(window)
                and self._text(window, connection.intern_atom("_NET_WM_NAME")) == title
            ]
            if len(matches) == 1:
                return matches[0]
            if len(matches) > 1:
                raise ValueError("新工作区窗口标题不唯一")
            remaining = deadline - time.monotonic()
            if (
                remaining <= 0
                or not select.select([connection.fileno()], [], [], remaining)[0]
            ):
                raise ValueError("无法定位新工作区窗口")
            while connection.pending_events():
                connection.next_event()

    def tag_workspace(self, title, workspace_id):
        if not WORKSPACE_ID_RE.fullmatch(workspace_id):
            raise ValueError("工作区 ID 无效")
        with self.lock:
            connection = display.Display()
            try:
                kind = connection.intern_atom("_GPC_WINDOW_KIND")
                workspace = connection.intern_atom("_GPC_WORKSPACE_ID")
                window = self._window_with_title(connection, title)
                if self._text(window, kind) or self._text(window, workspace):
                    raise ValueError("新工作区窗口已经存在标记")
                self._set(connection, window, kind, "workspace")
                self._set(connection, window, workspace, workspace_id)
                connection.sync()
            finally:
                connection.close()

    def tag_administrator(self):
        with self.lock:
            connection = display.Display()
            try:
                kind = connection.intern_atom("_GPC_WINDOW_KIND")
                workspace = connection.intern_atom("_GPC_WORKSPACE_ID")
                chromium = [
                    window
                    for window in self._windows(connection)
                    if self._is_chromium(window)
                ]
                administrators = [
                    window
                    for window in chromium
                    if self._text(window, kind) == "administrator"
                ]
                if len(administrators) == 1:
                    return
                if administrators:
                    raise ValueError("管理员窗口标记不唯一")
                untagged = [
                    window
                    for window in chromium
                    if not self._text(window, kind)
                    and not self._text(window, workspace)
                ]
                if len(untagged) != 1:
                    raise ValueError("无法唯一定位管理员窗口")
                self._set(connection, untagged[0], kind, "administrator")
                connection.sync()
            finally:
                connection.close()

    def route(self, parent_window):
        match = PARENT_RE.fullmatch(str(parent_window))
        if not match:
            raise ValueError("Portal 请求缺少有效 X11 父窗口")
        xid = int(match.group(1), 16)
        with self.lock:
            connection = display.Display()
            try:
                kind_atom = connection.intern_atom("_GPC_WINDOW_KIND")
                workspace = connection.intern_atom("_GPC_WORKSPACE_ID")
                windows = {
                    window.id: window
                    for window in self._windows(connection)
                    if self._is_chromium(window)
                }
                window = windows.get(xid)
                if not window:
                    raise ValueError("Portal 父窗口不属于 Chromium")
                kind = self._text(window, kind_atom)
                if kind == "administrator":
                    return "administrator", ""
                workspace_id = self._text(window, workspace)
                if kind != "workspace" or not WORKSPACE_ID_RE.fullmatch(workspace_id):
                    raise ValueError("Portal 父窗口没有有效工作区标记")
                return "workspace", workspace_id
            finally:
                connection.close()


class PortalRequest(dbus.service.Object):
    def __init__(self, bus, path, close_callback):
        super().__init__(bus, path)
        self.close_callback = close_callback
        self.closed = False
        self.socket = None
        self.lock = threading.Lock()

    def attach_socket(self, connection):
        with self.lock:
            if self.closed:
                connection.close()
                return False
            self.socket = connection
            return True

    @dbus.service.method(REQUEST_INTERFACE, in_signature="", out_signature="")
    def Close(self):
        with self.lock:
            if self.closed:
                return
            self.closed = True
            connection = self.socket
        if connection:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            connection.close()
        self.close_callback()


class FileChooser(dbus.service.Object):
    def __init__(self, bus, router):
        super().__init__(bus, PORTAL_PATH)
        self.bus = bus
        self.router = router
        self.requests = {}

    def _finish(self, request_id, response, results, reply_handler):
        request = self.requests.pop(request_id, None)
        if not request:
            return False
        request.remove_from_connection()
        reply_handler(dbus.UInt32(response), results)
        return False

    def _workspace_request(
        self, request_id, request, workspace_id, options, reply_handler
    ):
        def worker():
            response = 2
            results = empty_results()
            connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                connection.connect(GATEWAY_SOCKET)
                if not request.attach_socket(connection):
                    response = 1
                    return
                message = {
                    "type": "open",
                    "requestId": request_id,
                    "workspaceId": workspace_id,
                    "multiple": bool(options.get("multiple", False)),
                    "directory": bool(options.get("directory", False)),
                }
                connection.sendall(
                    (json.dumps(message, separators=(",", ":")) + "\n").encode()
                )
                buffer = b""
                while b"\n" not in buffer:
                    chunk = connection.recv(4096)
                    if not chunk:
                        raise ValueError("Gateway 已关闭 Portal 请求")
                    buffer += chunk
                    if len(buffer) > MAX_MESSAGE_BYTES:
                        raise ValueError("Gateway Portal 响应过大")
                payload = json.loads(buffer.split(b"\n", 1)[0])
                if payload.get("status") == "cancelled":
                    response = 1
                    return
                paths = payload.get("paths")
                if (
                    payload.get("status") != "selected"
                    or not isinstance(paths, list)
                    or not paths
                ):
                    raise ValueError("Gateway Portal 响应无效")
                if not bool(options.get("multiple", False)) and len(paths) != 1:
                    raise ValueError("单文件选择返回了多个路径")
                upload_root = os.path.realpath(UPLOAD_ROOT) + os.sep
                uris = []
                for path in paths:
                    resolved = os.path.realpath(str(path))
                    if (
                        not resolved.startswith(upload_root)
                        or not os.path.isfile(resolved)
                        or not os.access(resolved, os.R_OK)
                    ):
                        raise ValueError("Portal 文件不在私人上传目录")
                    uris.append(pathlib.Path(resolved).as_uri())
                response = 0
                results = dbus.Dictionary(
                    {"uris": dbus.Array(uris, signature="s")}, signature="sv"
                )
            except (OSError, ValueError):
                if request.closed:
                    response = 1
            finally:
                connection.close()
                GLib.idle_add(
                    self._finish, request_id, response, results, reply_handler
                )

        threading.Thread(target=worker, daemon=True).start()

    def _administrator_request(
        self,
        method,
        handle,
        app_id,
        parent_window,
        title,
        options,
        request_id,
        reply_handler,
    ):
        request = self.requests[request_id]

        def close_gtk():
            try:
                proxy = self.bus.get_object(GTK_BACKEND_NAME, handle)
                dbus.Interface(proxy, REQUEST_INTERFACE).Close()
            except dbus.DBusException:
                pass

        request.close_callback = close_gtk

        def finished(response, results):
            GLib.idle_add(
                self._finish, request_id, int(response), results, reply_handler
            )

        def failed(_error):
            GLib.idle_add(self._finish, request_id, 2, empty_results(), reply_handler)

        proxy = self.bus.get_object(GTK_BACKEND_NAME, PORTAL_PATH)
        getattr(dbus.Interface(proxy, FILE_CHOOSER_INTERFACE), method)(
            handle,
            app_id,
            parent_window,
            title,
            options,
            reply_handler=finished,
            error_handler=failed,
        )

    def _open(
        self,
        method,
        handle,
        app_id,
        parent_window,
        title,
        options,
        reply_handler,
        workspace_open,
    ):
        request_id = str(uuid.uuid4())
        request = PortalRequest(self.bus, handle, lambda: None)
        self.requests[request_id] = request
        try:
            kind, workspace_id = self.router.route(parent_window)
            if kind == "administrator":
                self._administrator_request(
                    method,
                    handle,
                    app_id,
                    parent_window,
                    title,
                    options,
                    request_id,
                    reply_handler,
                )
                return
            if not workspace_open:
                self._finish(request_id, 2, empty_results(), reply_handler)
                return
            if bool(options.get("directory", False)):
                self._finish(request_id, 2, empty_results(), reply_handler)
                return
            self._workspace_request(
                request_id, request, workspace_id, options, reply_handler
            )
        except (ValueError, error.XError, dbus.DBusException):
            self._finish(request_id, 2, empty_results(), reply_handler)

    @dbus.service.method(
        FILE_CHOOSER_INTERFACE,
        in_signature="osssa{sv}",
        out_signature="ua{sv}",
        async_callbacks=("reply_handler", "error_handler"),
    )
    def OpenFile(
        self,
        handle,
        app_id,
        parent_window,
        title,
        options,
        reply_handler,
        error_handler,
    ):
        del error_handler
        self._open(
            "OpenFile",
            handle,
            app_id,
            parent_window,
            title,
            options,
            reply_handler,
            True,
        )

    @dbus.service.method(
        FILE_CHOOSER_INTERFACE,
        in_signature="osssa{sv}",
        out_signature="ua{sv}",
        async_callbacks=("reply_handler", "error_handler"),
    )
    def SaveFile(
        self,
        handle,
        app_id,
        parent_window,
        title,
        options,
        reply_handler,
        error_handler,
    ):
        del error_handler
        self._open(
            "SaveFile",
            handle,
            app_id,
            parent_window,
            title,
            options,
            reply_handler,
            False,
        )

    @dbus.service.method(
        FILE_CHOOSER_INTERFACE,
        in_signature="osssa{sv}",
        out_signature="ua{sv}",
        async_callbacks=("reply_handler", "error_handler"),
    )
    def SaveFiles(
        self,
        handle,
        app_id,
        parent_window,
        title,
        options,
        reply_handler,
        error_handler,
    ):
        del error_handler
        self._open(
            "SaveFiles",
            handle,
            app_id,
            parent_window,
            title,
            options,
            reply_handler,
            False,
        )


class ControlServer(threading.Thread):
    def __init__(self, router):
        super().__init__(daemon=True)
        self.router = router

    def run(self):
        try:
            os.unlink(DESKTOP_SOCKET)
        except FileNotFoundError:
            pass
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(DESKTOP_SOCKET)
        os.chmod(DESKTOP_SOCKET, 0o660)
        server.listen(8)
        while True:
            connection, _address = server.accept()
            with connection:
                try:
                    buffer = b""
                    while b"\n" not in buffer:
                        chunk = connection.recv(4096)
                        if not chunk:
                            raise ValueError("窗口标记请求不完整")
                        buffer += chunk
                        if len(buffer) > MAX_MESSAGE_BYTES:
                            raise ValueError("窗口标记请求过大")
                    message = json.loads(buffer.split(b"\n", 1)[0])
                    if message.get("type") == "tag-workspace":
                        self.router.tag_workspace(
                            str(message.get("title", "")),
                            str(message.get("workspaceId", "")),
                        )
                    elif message.get("type") == "tag-administrator":
                        self.router.tag_administrator()
                    else:
                        raise ValueError("未知窗口标记请求")
                    response = {"ok": True}
                except (
                    ValueError,
                    OSError,
                    error.XError,
                ) as exception:
                    response = {"ok": False, "error": str(exception)}
                connection.sendall(
                    (json.dumps(response, separators=(",", ":")) + "\n").encode()
                )


def main():
    DBusGMainLoop(set_as_default=True)
    bus = dbus.SessionBus()
    router = WindowRouter()
    ControlServer(router).start()
    name = dbus.service.BusName(BACKEND_NAME, bus, do_not_queue=True)
    FileChooser(bus, router)
    GLib.MainLoop().run()
    del name


if __name__ == "__main__":
    main()
