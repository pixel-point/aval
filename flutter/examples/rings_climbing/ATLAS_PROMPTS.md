# Climbing atlas — camera: **behind**

**Primary identity:** rear-view still from user (`refs/character_rear_source.jpg`).

| Asset | Role |
| --- | --- |
| `refs/character_rear_flat.jpg` | Standing back, solid green |
| `portal/portal_pose.jpg` | Portal hang **from behind** (demo default) |
| `portal/portal_pose_rear.jpg` | Same (alias) |
| `loops/*` | Stamina + action loops, camera behind |
| `pivots/*` | Forward pivot ends, camera behind |
| `oneshots/*` | Reach / dyno / fall ends, camera behind |

Front-facing locks (if present) are secondary: `character_base.jpg`, `character_user_source.webp`.

Regenerate rule: always `image_edit` from `portal_pose_rear` / rear source so hair + harness stay consistent from the back.
---
## Jumps (rear)
- oneshots/jump_left.jpg, jump_right.jpg, jump_up.jpg (apex)
- loops/jump_left_charge.jpg, jump_right_charge.jpg, jump_up_charge.jpg (coil)
