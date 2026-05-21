#!/bin/sh
mkdir -p /mnt/nas/services/jellyfin/config
mkdir -p /mnt/nas/services/jellyfin/cache

sudo mkdir -p /opt/jellyfin/config
sudo mkdir -p /opt/jellyfin/cache

sudo docker run -d \
 --name jellyfin \
 --platform linux/arm64 \
 -e PUID=1001 \
 -e PGID=1003 \
 -e TZ=Australia/Hobart \
 --network host \
 --privileged \
 --volume /mnt/nas/services/jellyfin/config:/config \
 --volume /mnt/nas/services/jellyfin/cache:/cache \
 --mount type=bind,source=/mnt/nas/media/movies,target=/movies \
 --mount type=bind,source=/mnt/nas/media/tv,target=/tv \
 --restart=unless-stopped \
 lscr.io/linuxserver/jellyfin:latest


arch: arm64
cores: 4
features: nesting=1,keyctl=1
hostname: jellyfin
memory: 4096
mp0: /mnt/pve/NAS,mp=/mnt/nas
net0: name=eth0,bridge=link0,firewall=1,gw=192.168.0.1,hwaddr=BC:24:11:65:41:B0,ip=192.168.0.249/24,ip6=dhcp,type=veth
ostype: alpine
rootfs: NAS:101/vm-101-disk-0.raw,size=64G
swap: 4096
lxc.apparmor.profile: unconfined
lxc.cgroup.devices.allow: a
lxc.cap.drop: