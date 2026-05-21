su - sa

mkdir -p /mnt/nas/services/adguard/work
mkdir -p /mnt/nas/services/adguard/config

sudo docker run -d --name adguard --restart unless-stopped \
    -v /mnt/nas/services/adguard/work:/opt/adguardhome/work \
    -v /mnt/nas/services/adguard/config:/opt/adguardhome/conf \
    -p 53:53/tcp \
    -p 53:53/udp \
    -p 67:67/udp \
    -p 68:68/udp \
    -p 81:80/tcp \
    -p 444:443/tcp \
    -p 444:443/udp \
    -p 3000:3000/tcp \
    -p 853:853/tcp \
    -p 784:784/udp \
    -p 853:853/udp \
    -p 8853:8853/udp \
    -p 5443:5443/tcp \
    -p 5443:5443/udp \
    adguard/adguardhome