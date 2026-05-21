# Homelab Discovery Snapshot

Generated: 2026-05-21T10:27:40.565580+00:00

## Cluster

- Name: Nippon
- API endpoint sampled: https://192.168.0.20:8006 (9.1.9 / release 9.1)

## Proxmox nodes

| Node | IP | Online | Local |
|---|---:|---:|---:|
| emperor | 192.168.0.6 | 1 | 0 |
| jester | 192.168.0.8 | 1 | 0 |
| shogun | 192.168.0.7 | 1 | 0 |
| tori | 192.168.0.20 | 1 | 1 |
| toyota | 192.168.0.21 | 1 | 0 |

## Guests

| Type | Node | VMID | Name | Status | Max Mem GiB | Max Disk GiB |
|---|---|---:|---|---|---:|---:|
| lxc | emperor | 100 | critical | running | 4 | 62 |
| qemu | shogun | 103 | NAS-OMV | stopped | 6 | 64 |
| lxc | toyota | 110 |  | unknown | 0 | 0 |
| lxc | toyota | 111 |  | unknown | 0 | 0 |
| lxc | toyota | 112 |  | unknown | 0 | 0 |

## Storage

| Storage | Type | Shared | Enabled | Content |
|---|---|---:|---:|---|
| local | dir |  |  | snippets,backup,iso,rootdir,images,vztmpl |
| NAS | nfs | 1 |  | vztmpl,images,rootdir,import,iso,backup,snippets |

## Network scan

Subnet: 192.168.0.0/24

| IP | Open TCP ports checked | Initial guess |
|---|---|---|
| 192.168.0.1 | 53, 80, 443 | web UI |
| 192.168.0.6 | 22, 111, 8006 | Proxmox |
| 192.168.0.7 | 22, 111, 8006 | Proxmox |
| 192.168.0.8 | 22, 111, 8006 | Proxmox |
| 192.168.0.20 | 22, 111, 8006 | Proxmox |
| 192.168.0.21 | 22, 80, 111, 8006 | Proxmox, web UI |
| 192.168.0.50 | 22, 80, 443, 5432 | PostgreSQL, web UI |
| 192.168.0.51 | 22, 5432 | PostgreSQL |
| 192.168.0.52 | 22 |  |
| 192.168.0.53 | 22 |  |
| 192.168.0.57 | 22, 80, 443 | web UI |
| 192.168.0.67 | 9000 | web/app candidate |
| 192.168.0.100 | 139, 445 | SMB/NAS candidate |
| 192.168.0.253 | 22, 80, 443 | web UI |

## Immediate findings

- Proxmox cluster name appears to be `Nippon` with five nodes: emperor, jester, shogun, tori, toyota.
- NAS storage is configured in Proxmox as an NFS storage named `NAS` and supports backups, images, rootdir, ISO, snippets, templates, and import content.
- Guest `NAS-OMV` exists as VMID 103 on `shogun` but is currently stopped according to Proxmox cluster resources.
- Several guests/nodes are reported as `unknown` from cluster resources; this needs follow-up because it may indicate version skew, cluster comms issues, or stale metadata.
- Public/router candidate is 192.168.0.1 with DNS/HTTP/HTTPS.
- SMB/NAS candidate discovered at 192.168.0.100 with ports 139/445.

## Next actions

1. Map every discovered IP to hostname/MAC/vendor/service owner.
2. Verify NAS role and backup target details before changing backup jobs.
3. Build a backup coverage matrix for every guest/service.
4. Add health checks and monitoring for Proxmox nodes, NAS, containers, and public endpoints.
5. Investigate stopped `NAS-OMV` and `unknown` node/guest statuses before making reliability changes.
