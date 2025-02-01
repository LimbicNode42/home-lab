# Boot Order
1. NAS
2. postgre & redis
3. infisical
4. keycloak

# home-network

To mount NAS to LXC
```
nano /etc/pve/lxc/CTID.conf
```
Add
```
mp0: /mnt/pve/NAS,mp=/mnt/nas
```
