FROM lscr.io/linuxserver/baseimage-kasmvnc:debianbookworm

ENV DEBIAN_FRONTEND=noninteractive

# Chromium 版本升级必须重新验证 KasmVNC 软件渲染与 Profile 重启。
ARG CHROMIUM_SNAPSHOT=20260704T180435Z
ARG CHROMIUM_VERSION=149.0.7827.196-1~deb12u1

RUN set -eux; \
    mkdir -p /gpc-apt-bak; \
    cp -a /etc/apt/sources.list /gpc-apt-bak/; \
    mv /etc/apt/sources.list.d/docker.list /etc/apt/sources.list.d/nodesource.list /gpc-apt-bak/ 2>/dev/null || true; \
    { \
      echo "deb http://deb.debian.org/debian bookworm main contrib non-free non-free-firmware"; \
      echo "deb http://deb.debian.org/debian bookworm-updates main contrib non-free non-free-firmware"; \
      echo "deb http://security.debian.org/debian-security/ bookworm-security main contrib non-free non-free-firmware"; \
    } > /etc/apt/sources.list; \
    echo "deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/${CHROMIUM_SNAPSHOT}/ bookworm-security main" \
      > /etc/apt/sources.list.d/gpc-chromium-pin.list; \
    printf 'Package: chromium*\nPin: version %s\nPin-Priority: 1001\n' "${CHROMIUM_VERSION}" \
      > /etc/apt/preferences.d/gpc-chromium-pin; \
    apt-get -o Acquire::Languages=none -o Acquire::Retries=3 update; \
    apt-get install -y --no-install-recommends \
        curl ca-certificates locales \
        fonts-noto-cjk fonts-noto-color-emoji fonts-wqy-microhei \
        chromium="${CHROMIUM_VERSION}" \
        python3-xlib \
        xdg-desktop-portal xdg-desktop-portal-gtk \
        xsettingsd; \
    chromium --version; \
    rm -f /etc/apt/sources.list.d/gpc-chromium-pin.list /etc/apt/preferences.d/gpc-chromium-pin; \
    mv /gpc-apt-bak/sources.list /etc/apt/sources.list; \
    mv /gpc-apt-bak/docker.list /gpc-apt-bak/nodesource.list /etc/apt/sources.list.d/ 2>/dev/null || true; \
    rm -rf /gpc-apt-bak; \
    sed -i 's/# zh_CN.UTF-8 UTF-8/zh_CN.UTF-8 UTF-8/' /etc/locale.gen; \
    locale-gen; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

ENV LANG=zh_CN.UTF-8 \
    LC_ALL=zh_CN.UTF-8 \
    LIBGL_ALWAYS_SOFTWARE=1

COPY identity.sh /custom-cont-init.d/00-identity
COPY update-autostart.sh /custom-cont-init.d/01-autostart
COPY proxy-init.sh /custom-cont-init.d/02-proxy
COPY transfer-init.sh /custom-cont-init.d/03-transfer
COPY hide-kasm.sh /custom-cont-init.d/04-hide-kasm
COPY portal-init.sh /custom-cont-init.d/05-portal
COPY cdp-fwd.py /usr/local/bin/gpc-cdp-fwd
COPY file-portal.py /usr/local/bin/gpc-file-portal
COPY gpc.portal /usr/share/xdg-desktop-portal/portals/gpc.portal
COPY gptpro-portals.conf /usr/share/xdg-desktop-portal/gptpro-portals.conf
COPY org.freedesktop.impl.portal.desktop.gpc.service /usr/share/dbus-1/services/org.freedesktop.impl.portal.desktop.gpc.service
COPY autostart /defaults/autostart
RUN chmod 755 /custom-cont-init.d/00-identity \
              /custom-cont-init.d/01-autostart \
              /custom-cont-init.d/02-proxy \
              /custom-cont-init.d/03-transfer \
              /custom-cont-init.d/04-hide-kasm \
              /custom-cont-init.d/05-portal \
              /usr/local/bin/gpc-cdp-fwd \
              /usr/local/bin/gpc-file-portal \
              /defaults/autostart

EXPOSE 3000 3001
