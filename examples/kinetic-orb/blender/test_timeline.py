"""Regression tests for the kinetic-orb authored timeline."""

from __future__ import annotations

import unittest

from timeline import (
    ANGULAR_STEP_DEGREES,
    FRAME_END,
    FRAME_START,
    HOVER_ENERGY,
    IDLE_ENERGY,
    PORTAL_FRAMES,
    SYMMETRY_DEGREES,
    UNIT_RANGES,
    max_portal_wait,
    pose_for_frame,
    validate_timeline,
)


class TimelineTests(unittest.TestCase):
    def test_unit_ranges_match_the_authored_graph(self) -> None:
        self.assertEqual(
            UNIT_RANGES,
            {
                "intro": (0, 24),
                "idle-loop": (24, 48),
                "hover-in": (48, 60),
                "hover-loop": (60, 84),
                "hover-out": (84, 96),
            },
        )

    def test_every_source_frame_moves_forward_by_five_degrees(self) -> None:
        for frame in range(FRAME_START, FRAME_END):
            with self.subTest(frame=frame):
                delta = pose_for_frame(frame + 1).angle_degrees - pose_for_frame(frame).angle_degrees
                self.assertAlmostEqual(delta, ANGULAR_STEP_DEGREES)

    def test_illumination_endpoints_match_exactly(self) -> None:
        expected = {
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
        for frame, energy in expected.items():
            with self.subTest(frame=frame):
                self.assertAlmostEqual(pose_for_frame(frame).energy, energy)

    def test_all_fixed_seams_advance_by_one_visual_step(self) -> None:
        seams = (
            (23, 24, "intro to idle"),
            (47, 24, "idle loop"),
            (59, 60, "hover-in completion"),
            (59, 84, "interrupted hover-in"),
            (83, 60, "hover loop"),
            (95, 24, "hover-out completion"),
        )
        for source, target, label in seams:
            with self.subTest(seam=label):
                self.assertVisualContinuation(source, target)

    def test_portals_match_their_transition_targets(self) -> None:
        self.assertEqual(PORTAL_FRAMES, (2, 5, 8, 11, 14, 17, 20, 23))
        self.assertEqual(max_portal_wait(24, PORTAL_FRAMES), 2)

        for local_frame in PORTAL_FRAMES:
            with self.subTest(state="idle", local_frame=local_frame):
                self.assertVisualContinuation(24 + local_frame, 48)
                self.assertAlmostEqual(pose_for_frame(24 + local_frame).energy, IDLE_ENERGY)
                self.assertAlmostEqual(pose_for_frame(48).energy, IDLE_ENERGY)
            with self.subTest(state="hover", local_frame=local_frame):
                self.assertVisualContinuation(60 + local_frame, 84)
                self.assertAlmostEqual(pose_for_frame(60 + local_frame).energy, HOVER_ENERGY)
                self.assertAlmostEqual(pose_for_frame(84).energy, HOVER_ENERGY)

    def test_built_in_contract_validator_passes(self) -> None:
        validate_timeline()

    def assertVisualContinuation(self, source_frame: int, target_frame: int) -> None:  # noqa: N802
        expected_angle = pose_for_frame(source_frame).angle_degrees + ANGULAR_STEP_DEGREES
        target_angle = pose_for_frame(target_frame).angle_degrees
        phase_error = (target_angle - expected_angle) % SYMMETRY_DEGREES
        self.assertAlmostEqual(phase_error, 0.0)


if __name__ == "__main__":
    unittest.main()
