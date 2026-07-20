"""Pure authored timeline contract for the kinetic-orb Blender render."""

from __future__ import annotations

from dataclasses import dataclass


FPS = 24
FRAME_START = 0
FRAME_END = 95
ANGLE_ORIGIN_FRAME = 24
ANGULAR_STEP_DEGREES = 5.0
SYMMETRY_DEGREES = 15.0
IDLE_ENERGY = 0.24
HOVER_ENERGY = 1.0
PORTAL_FRAMES = (2, 5, 8, 11, 14, 17, 20, 23)
UNIT_RANGES = {
    "intro": (0, 24),
    "idle-loop": (24, 48),
    "hover-in": (48, 60),
    "hover-loop": (60, 84),
    "hover-out": (84, 96),
}


@dataclass(frozen=True)
class Pose:
    """The only two animated properties in the calibration scene."""

    angle_degrees: float
    energy: float


def smoothstep(value: float) -> float:
    value = max(0.0, min(1.0, value))
    return value * value * (3.0 - 2.0 * value)


def mix(start: float, end: float, amount: float) -> float:
    return start + (end - start) * amount


def pose_for_frame(frame: float) -> Pose:
    """Return an absolute phase and endpoint-matched illumination for a source frame."""

    angle = (frame - ANGLE_ORIGIN_FRAME) * ANGULAR_STEP_DEGREES

    if frame < 24.0:
        energy = mix(0.0, IDLE_ENERGY, smoothstep(frame / 23.0))
    elif frame < 48.0:
        energy = IDLE_ENERGY
    elif frame < 60.0:
        energy = mix(IDLE_ENERGY, HOVER_ENERGY, smoothstep((frame - 48.0) / 11.0))
    elif frame < 84.0:
        energy = HOVER_ENERGY
    else:
        energy = mix(HOVER_ENERGY, IDLE_ENERGY, smoothstep((frame - 84.0) / 11.0))

    return Pose(angle_degrees=angle, energy=energy)


def max_portal_wait(frame_count: int, portal_frames: tuple[int, ...]) -> int:
    """Return the largest forward distance from any loop frame to a portal."""

    if frame_count <= 0:
        raise ValueError("frame_count must be positive")
    if not portal_frames:
        raise ValueError("portal_frames must not be empty")
    if any(frame < 0 or frame >= frame_count for frame in portal_frames):
        raise ValueError("portal frame falls outside the loop")

    return max(
        min((portal - current) % frame_count for portal in portal_frames)
        for current in range(frame_count)
    )


def validate_timeline() -> None:
    """Reject any authored change that breaks a visible seam or latency bound."""

    expected_ranges = {
        "intro": (0, 24),
        "idle-loop": (24, 48),
        "hover-in": (48, 60),
        "hover-loop": (60, 84),
        "hover-out": (84, 96),
    }
    if UNIT_RANGES != expected_ranges:
        raise ValueError("unit ranges no longer match the authored graph")

    for frame in range(FRAME_START, FRAME_END):
        delta = pose_for_frame(frame + 1).angle_degrees - pose_for_frame(frame).angle_degrees
        _require_close(delta, ANGULAR_STEP_DEGREES, f"angular velocity at frame {frame}")

    energy_endpoints = {
        23: IDLE_ENERGY,
        24: IDLE_ENERGY,
        47: IDLE_ENERGY,
        48: IDLE_ENERGY,
        59: HOVER_ENERGY,
        60: HOVER_ENERGY,
        83: HOVER_ENERGY,
        84: HOVER_ENERGY,
        95: IDLE_ENERGY,
    }
    for frame, expected in energy_endpoints.items():
        _require_close(pose_for_frame(frame).energy, expected, f"energy at frame {frame}")

    fixed_seams = (
        (23, 24, "intro to idle"),
        (47, 24, "idle loop"),
        (59, 60, "hover-in completion"),
        (59, 84, "interrupted hover-in"),
        (83, 60, "hover loop"),
        (95, 24, "hover-out completion"),
    )
    for source, target, label in fixed_seams:
        _require_visual_continuation(source, target, label)

    if PORTAL_FRAMES != (2, 5, 8, 11, 14, 17, 20, 23):
        raise ValueError("portal frames no longer follow the three-frame cadence")
    if max_portal_wait(24, PORTAL_FRAMES) != 2:
        raise ValueError("portal wait exceeds two frames")

    for local_frame in PORTAL_FRAMES:
        _require_visual_continuation(24 + local_frame, 48, f"idle portal {local_frame}")
        _require_visual_continuation(60 + local_frame, 84, f"hover portal {local_frame}")


def _require_visual_continuation(source_frame: int, target_frame: int, label: str) -> None:
    expected = pose_for_frame(source_frame).angle_degrees + ANGULAR_STEP_DEGREES
    target = pose_for_frame(target_frame).angle_degrees
    phase_error = (target - expected) % SYMMETRY_DEGREES
    _require_close(phase_error, 0.0, f"phase at {label}")


def _require_close(actual: float, expected: float, label: str) -> None:
    if abs(actual - expected) > 1e-9:
        raise ValueError(f"{label}: expected {expected}, received {actual}")


if __name__ == "__main__":
    validate_timeline()
    print("kinetic-orb timeline contract is valid")
