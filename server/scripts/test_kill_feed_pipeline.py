#!/usr/bin/env python3
"""Unit tests for kill-feed pipeline (dedup, merge, POV clustering)."""
import unittest

from kill_feed_pipeline import (
    KillFeedConfig,
    classify_registry_entry,
    cluster_names,
    fingerprint_match,
    find_registry_match,
    merge_clips,
    normalize_name,
    parse_kill_fingerprint,
    select_pov_cluster,
)


class TestFingerprintDedup(unittest.TestCase):
    def test_fuzzy_ocr_noise(self):
        a = parse_kill_fingerprint("DoTox_ AK pooh")
        b = parse_kill_fingerprint("DoT0x_ AK pooh")
        self.assertTrue(fingerprint_match(a, b, 0.85))

    def test_different_kills_not_merged(self):
        a = parse_kill_fingerprint("donk player_alpha")
        b = parse_kill_fingerprint("donk player_omega")
        self.assertFalse(fingerprint_match(a, b, 0.85))

    def test_registry_dedup(self):
        fp = parse_kill_fingerprint("lilpeepfan pooh")
        registry = [{"fingerprint": parse_kill_fingerprint("lilpeepfan- pooh")}]
        self.assertIsNotNone(find_registry_match(fp, registry, 0.85))


class TestNameClustering(unittest.TestCase):
    def test_ocr_fragments_cluster(self):
        names = ["ene", "en3", "dotox", "dot0x", "dotox_"]
        clusters = cluster_names(names, 0.75)
        reps = [c["representative"] for c in clusters]
        self.assertTrue(any("dotox" in r for r in reps))
        dotox_cluster = next(c for c in clusters if "dotox" in c["representative"])
        self.assertGreaterEqual(dotox_cluster["count"], 2)

    def test_normalize_strips_garbage(self):
        self.assertEqual(normalize_name("DoTox_!"), "dotox_")


class TestPovCluster(unittest.TestCase):
    def test_fallback_excludes_pov_deaths(self):
        cfg = KillFeedConfig()
        registry = [
            {"killer": "enemy1", "victim": "dotox", "anchor_s": 10.0},
            {"killer": "enemy2", "victim": "other", "anchor_s": 20.0},
        ]
        kind, _ = classify_registry_entry(registry[0], "dotox", cfg, fallback_mode=True)
        self.assertEqual(kind, "death")
        kind2, _ = classify_registry_entry(registry[1], "dotox", cfg, fallback_mode=True)
        self.assertEqual(kind2, "kill")

    def test_pov_kill_match(self):
        cfg = KillFeedConfig()
        entry = {"killer": "dotox_", "victim": "pooh", "anchor_s": 10.0}
        kind, reason = classify_registry_entry(entry, "dotox", cfg, fallback_mode=False)
        self.assertEqual(kind, "kill")
        self.assertEqual(reason, "pov_killer_match")


class TestMergeClips(unittest.TestCase):
    def setUp(self):
        self.cfg = KillFeedConfig(merge_gap_sec=5.0, lead_sec=4.0, tail_sec=2.0)

    def test_merge_within_gap(self):
        clips = merge_clips([10.0, 14.0], self.cfg, duration=100.0)
        self.assertEqual(len(clips), 1)
        self.assertEqual(clips[0]["kill_count"], 2)

    def test_split_beyond_gap(self):
        clips = merge_clips([10.0, 16.5], self.cfg, duration=100.0)
        self.assertEqual(len(clips), 2)

    def test_exactly_at_merge_gap(self):
        clips = merge_clips([10.0, 15.0], self.cfg, duration=100.0)
        self.assertEqual(len(clips), 1)

    def test_overlapping_lead_tail_merged(self):
        clips = merge_clips([10.0, 15.5], self.cfg, duration=100.0)
        self.assertEqual(len(clips), 1)
        self.assertEqual(clips[0]["end_s"], 17.5)

    def test_boundary_clamp(self):
        clips = merge_clips([2.0, 3.0], self.cfg, duration=5.0)
        self.assertEqual(clips[0]["start_s"], 0.0)
        self.assertEqual(clips[0]["end_s"], 5.0)


if __name__ == "__main__":
    unittest.main()
