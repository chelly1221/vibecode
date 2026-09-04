#!/bin/sh
# Re-register WSL Windows interop after another distro's systemd-binfmt flushed it (kernel < 6.7 shares binfmt_misc).
# Works without sudo: /init runs wsl.exe directly; `wsl -u root` needs no password.
if [ -e /proc/sys/fs/binfmt_misc/WSLInterop ]; then echo "interop ok"; exit 0; fi
cat > /tmp/fix-binfmt.sh <<'INNER'
echo ':WSLInterop:M::MZ::/init:PF' > /proc/sys/fs/binfmt_misc/register && echo registered
INNER
/init /mnt/c/WINDOWS/system32/wsl.exe wsl.exe -d "${WSL_DISTRO_NAME:-Ubuntu}" -u root -e sh /tmp/fix-binfmt.sh
