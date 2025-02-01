#!/bin/sh
apk update

apk add nano docker openssl sudo
rc-update add docker boot
service docker start

#
# Setup OMV NFS user
#
# values come from OMV user
sudo addgroup -g 1003 sa
sudo adduser -u 1001 -G users sa
sudo addgroup sa sa
sudo id sa
# If duplicate groups
sudo delgroup sa users
sudo id sa
# EXPECTED OUTPUT
# uid=1001(sa) gid=100(users) groups=100(users),1003(sa)
sudo echo '%sa ALL=(ALL) ALL' > /etc/sudoers.d/sa

#
# Use NFS share user
#
su - sa

#
# Get secret store fetching toool
#
wget https://github.com/Infisical/infisical/releases/download/infisical-cli/v0.34.2/infisical_0.34.2_linux_arm64.tar.gz
tar -xvf infisical_0.34.2_linux_arm64.tar.gz
chmod +x infisical
sudo mv infisical /usr/local/bin/infisical
infisical login
infisical init
