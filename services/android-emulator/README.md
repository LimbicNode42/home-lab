# Android emulator service seed

Candidate desired-state seed for the persistent Android emulator on `tori`.

Live state verified for task `t_7ff30128`:

- AVD: `agent_feedback`
- Emulator: `android-emulator.service`, enabled and active
- Display stack: `android-xvfb.service`, `android-vnc.service`, `android-novnc.service`, enabled and active
- Dashboard status publisher: `android-dashboard-status.timer`, enabled and active; runs `android-dashboard-status.service` every minute
- noVNC viewer: local tunnel target `http://127.0.0.1:6080/vnc.html` after `ssh -L 6080:127.0.0.1:6080 tori`

Secrets are not stored here. The noVNC access code remains operator-local and should be moved to Vaultwarden folder `homelab`, item `android-emulator/novnc-token` before further automation.
