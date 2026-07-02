#!/usr/bin/env python3
"""Unit tests for kill-detection scoring (no video/OCR required)."""
from __future__ import annotations

import unittest

from scoring import match_timestamps


class MatchTimestampsTest(unittest.TestCase):
    def test_perfect_match(self) -> None:
        gt = [10.0, 20.0, 30.0]
        det = [10.0, 20.0, 30.0]
        m = match_timestamps(gt, det, 2.0)
        self.assertEqual(m["true_positives"], 3)
        self.assertEqual(m["false_positives"], 0)
        self.assertEqual(m["false_negatives"], 0)
        self.assertEqual(m["precision"], 1.0)
        self.assertEqual(m["recall"], 1.0)

    def test_tolerance_window(self) -> None:
        gt = [100.0]
        det = [101.5]
        m = match_timestamps(gt, det, 2.0)
        self.assertEqual(m["true_positives"], 1)
        self.assertAlmostEqual(m["matches"][0]["delta_sec"], 1.5)

    def test_outside_tolerance_is_fp_and_fn(self) -> None:
        gt = [50.0]
        det = [54.0]
        m = match_timestamps(gt, det, 2.0)
        self.assertEqual(m["true_positives"], 0)
        self.assertEqual(m["false_positives"], 1)
        self.assertEqual(m["false_negatives"], 1)

    def test_one_to_one_matching(self) -> None:
        gt = [10.0, 11.0]
        det = [10.5, 11.5]
        m = match_timestamps(gt, det, 2.0)
        self.assertEqual(m["true_positives"], 2)
        self.assertEqual(m["false_positives"], 0)


if __name__ == "__main__":
    unittest.main()
