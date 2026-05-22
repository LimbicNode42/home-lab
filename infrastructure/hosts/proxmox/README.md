# Proxmox host desired state

Status: candidate seed from existing discovery evidence.

This directory is for non-secret Proxmox cluster intent, drift reports, and future Terraform/OpenTofu/Ansible integration. The current files must not be applied as live truth until refreshed against the cluster with read-only commands/API calls.

Known priority risk: qdevice/qnetd has previously depended on the NAS VM at `192.168.0.250`. That can deadlock quorum because the NAS VM may need cluster quorum to start. The desired resolution is to move qdevice/qnetd off cluster-dependent storage/VMs, but that is a live cluster mutation and requires explicit approval.
