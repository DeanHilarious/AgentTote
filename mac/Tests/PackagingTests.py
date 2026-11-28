"""Packaging orchestration tests with simulated build/download/signing tools.
Run: python3 mac/Tests/PackagingTests.py. No network, keychain or disk mounts.
Real shasum, tar, plutil and file operations verify cache integrity and app layout.
"""
import hashlib
import io
import json
import os
import plistlib
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
MOCK = r'''#!/usr/bin/env python3
import json, os, pathlib, shutil, sys
p = pathlib.Path
root = p(os.environ["AA_PACKAGE_TEST_ROOT"])
a = sys.argv[1:]
tool = p(sys.argv[0]).name
with (root / "calls.jsonl").open("a") as f: f.write(json.dumps([tool, a]) + "\n")
if tool == "swift":
    if a[0].endswith(".swift"):
        p(a[1]).touch()
    else:
        if "x86_64" in a and os.environ.get("AA_PACKAGE_TEST_FALLBACK"): sys.exit(1)
        out = root / "mac/.build/fake-release"
        out.mkdir(parents=True, exist_ok=True)
        binary = out / "AgentAnywhere"
        binary.write_text("#!/bin/sh\nexit 0\n"); binary.chmod(0o755)
        bundle = out / "AgentAnywhere_AgentAnywhereMac.bundle"
        if "x86_64" in a: bundle = bundle / "Contents/Resources"
        bundle.mkdir(parents=True, exist_ok=True)
        (bundle / "SpaceGrotesk.ttf").touch()
        if "--show-bin-path" in a: print(out)
elif tool == "npm":
    out = root / "bridge/dist"; out.mkdir(parents=True, exist_ok=True)
    (out / "bridge.mjs").write_text("// bundled fixture")
elif tool == "curl":
    shutil.copyfile(root / "remote" / a[a.index("-o") - 1].rsplit("/", 1)[1], a[a.index("-o") + 1])
elif tool == "lipo": shutil.copyfile(a[1], a[a.index("-output") + 1])
elif tool in ("sips", "iconutil"):
    p(a[a.index("--out" if tool == "sips" else "-o") + 1]).touch()
elif tool == "hdiutil":
    stage = p(a[a.index("-srcfolder") + 1])
    assert (stage / "Applications").is_symlink()
    assert os.readlink(stage / "Applications") == "/Applications"
    assert (stage / "AgentAnywhere.app/Contents/Resources/bridge/bridge.mjs").is_file()
    p(a[-1]).touch()
elif tool == "xcrun" and a[0] == "notarytool":
    print(json.dumps({"status": os.environ.get("AA_PACKAGE_TEST_NOTARY", "Accepted")}))
# codesign and stapler are recorded, never access the real keychain/service.
'''


class PackagingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="aa-packaging-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        shutil.copytree(SCRIPTS, self.root / "mac/scripts")
        for language in ("en", "zh-Hans"):
            strings = Path(f"ios/AgentAnywhere/{language}.lproj/Localizable.strings")
            (self.root / strings.parent).mkdir(parents=True)
            shutil.copyfile(SCRIPTS.parents[1] / strings, self.root / strings)
        (self.root / "bridge").mkdir()
        (self.root / "bridge/package.json").write_text('{"version":"1.2.3"}')
        remote = self.root / "remote"
        remote.mkdir()
        sums = []
        for arch in ("arm64", "x64"):
            base = f"node-v22.23.0-darwin-{arch}"
            archive = remote / (base + ".tar.gz")
            with tarfile.open(archive, "w:gz") as tar:
                for name, content, mode in (("bin/node", b"#!/bin/sh\nexit 0\n", 0o755), ("LICENSE", b"fixture license", 0o644)):
                    entry = tarfile.TarInfo(base + "/" + name)
                    entry.size, entry.mode = len(content), mode
                    tar.addfile(entry, io.BytesIO(content))
            sums.append(hashlib.sha256(archive.read_bytes()).hexdigest() + "  " + archive.name)
        (remote / "SHASUMS256.txt").write_text("\n".join(sums) + "\n")
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        for tool in ("swift", "npm", "curl", "lipo", "sips", "iconutil", "codesign", "hdiutil", "xcrun"):
            script = bin_dir / tool
            script.write_text(MOCK)
            script.chmod(0o755)
        self.env = dict(os.environ, PATH=str(bin_dir) + ":" + os.environ["PATH"], AA_PACKAGE_TEST_ROOT=str(self.root))
        self.env.pop("SIGN_IDENTITY", None)
        self.env.pop("NOTARY_PROFILE", None)
        self.env.pop("BUILD_NUMBER", None)
        self.env.pop("AA_UPDATE_FEED_URL", None)

    def build(self, **env):
        result = subprocess.run(["bash", str(self.root / "mac/scripts/build-app.sh")], env=dict(self.env, **env), capture_output=True, text=True)
        return result

    def calls(self, tool):
        return [args for name, args in map(json.loads, (self.root / "calls.jsonl").read_text().splitlines()) if name == tool]

    def testUniversalAdHocLayoutAndVerifiedCache(self):
        result = self.build()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue((self.root / "mac/dist/AgentAnywhere-1.2.3.dmg").exists())
        self.assertEqual(len(self.calls("lipo")), 1)
        signed = [c for c in self.calls("codesign") if "--sign" in c]
        self.assertEqual([c[c.index("--sign") + 1] for c in signed], ["-", "-", "-"])
        self.assertTrue(signed[0][-1].endswith("/Resources/node"))
        self.assertTrue(signed[1][-1].endswith(".app"))
        self.assertFalse(any("--timestamp" in c for c in signed))
        self.assertEqual(len(self.calls("curl")), 3)
        info_path = self.root / "mac/dist/AgentAnywhere.app/Contents/Info.plist"
        first = plistlib.loads(info_path.read_bytes())
        self.assertEqual(first["CFBundleShortVersionString"], "1.2.3")
        self.assertEqual(first["CFBundleDisplayName"], "AgentTote")
        self.assertEqual(first["CFBundleIdentifier"], "com.deanhilarious.agentanywhere.mac")
        localized_name = info_path.parent / "Resources/zh-Hans.lproj/InfoPlist.strings"
        self.assertIn('"CFBundleDisplayName" = "口袋智能体";', localized_name.read_text())
        strings = localized_name.with_name("Localizable.strings")
        self.assertIn('"Accepted" = "已验收";', strings.read_text())
        self.assertTrue(first["CFBundleVersion"].isdigit())
        self.assertEqual(first["AAUpdateFeedURL"], "https://agent-anywhere.nuts-claw.tech/updates/mac/latest.json")
        self.assertNotIn("AAUpdatePublicKey", first)
        self.assertEqual(self.build().returncode, 0)
        second = plistlib.loads(info_path.read_bytes())
        self.assertGreater(int(second["CFBundleVersion"]), int(first["CFBundleVersion"]))
        self.assertEqual(len(self.calls("curl")), 3, "Second build must not redownload")
        cache = self.root / "mac/.build/node-cache/v22.23.0"
        next(cache.glob("*.tar.gz")).write_bytes(b"corrupted")
        self.assertNotEqual(self.build().returncode, 0, "Corrupt cached downloads must fail closed")

    def testFallbackSignsAndNotarizesBothArtifacts(self):
        result = self.build(SIGN_IDENTITY="Test Developer ID", NOTARY_PROFILE="test-profile", AA_PACKAGE_TEST_FALLBACK="1")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("falling back", result.stderr)
        self.assertEqual(self.calls("lipo"), [])
        signed = [c for c in self.calls("codesign") if "--sign" in c]
        self.assertTrue(all("--timestamp" in c for c in signed))
        submissions = [c for c in self.calls("xcrun") if c[0] == "notarytool"]
        self.assertEqual(len(submissions), 2)
        self.assertTrue(all("--wait" in c and "--output-format" in c for c in submissions))
        staples = [c for c in self.calls("xcrun") if c[:2] == ["stapler", "staple"]]
        self.assertEqual(len(staples), 2)
        self.assertTrue(staples[0][-1].endswith("AgentAnywhere.app"))
        self.assertTrue(staples[1][-1].endswith(".dmg"))

    def testOTAPublicKeyAndBuildOverride(self):
        # A public-key fixture only; no real signing material is generated or accessed.
        import base64
        key = base64.b64encode(bytes(range(32))).decode()
        (self.root / "mac/ota-public-key.txt").write_text(key + "\n")
        result = self.build(BUILD_NUMBER="20991231235959", AA_UPDATE_FEED_URL="https://updates.example.test/latest.json")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        info = plistlib.loads((self.root / "mac/dist/AgentAnywhere.app/Contents/Info.plist").read_bytes())
        self.assertEqual(info["CFBundleVersion"], "20991231235959")
        self.assertEqual(info["AAUpdatePublicKey"], key)
        self.assertEqual(info["AAUpdateFeedURL"], "https://updates.example.test/latest.json")
        result = self.build(BUILD_NUMBER="20991231235959")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must exceed", result.stderr)

    def testNotaryRejectionStopsBeforeStaplingOrDMG(self):
        result = self.build(SIGN_IDENTITY="Test Developer ID", NOTARY_PROFILE="test-profile", AA_PACKAGE_TEST_NOTARY="Invalid")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("did not reach Accepted", result.stderr)
        self.assertEqual(self.calls("hdiutil"), [])
        self.assertFalse(any(c[0] == "stapler" for c in self.calls("xcrun")))

    def testAdHocCannotRequestNotarization(self):
        result = self.build(NOTARY_PROFILE="test-profile")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("requires SIGN_IDENTITY", result.stderr)


class UpdateInstallerTests(unittest.TestCase):
    """Run the real installer logic with disposable apps and controlled mv/open failures."""
    def run_installer(self, *, fail_move=False, fail_open=False):
        temporary = tempfile.TemporaryDirectory(prefix="aa-installer-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        destination = root / "App with ' spaces.app"
        destination.mkdir()
        (destination / "version").write_text("old")
        stage = root / ".AgentAnywhere-update-test"
        stage.mkdir()
        candidate = stage / "AgentAnywhere.app"
        candidate.mkdir()
        (candidate / "version").write_text("new")
        move = root / "fake-mv"
        move.write_text('#!/bin/sh\nif [ "$AA_TEST_FAIL_MOVE" = 1 ] && [ "$1" = "$AA_TEST_CANDIDATE" ]; then exit 1; fi\nexec /bin/mv "$@"\n')
        move.chmod(0o755)
        opener = root / "fake-open"
        opener.write_text('#!/bin/sh\nif [ "$AA_TEST_FAIL_OPEN" = 1 ] && [ "$(cat "$1/version")" = new ]; then exit 1; fi\nexit 0\n')
        opener.chmod(0o755)
        source = SCRIPTS.parent / "Sources/AgentAnywhereMac/Resources/install-update.sh"
        helper = root / "installer.sh"
        helper.write_text(source.read_text().replace('/bin/mv', '"' + str(move) + '"').replace('/usr/bin/open', '"' + str(opener) + '"'))
        result = subprocess.run(["/bin/sh", str(helper), "2147483647", str(destination), str(stage)],
            env=dict(os.environ, AA_TEST_FAIL_MOVE=str(int(fail_move)), AA_TEST_FAIL_OPEN=str(int(fail_open)), AA_TEST_CANDIDATE=str(candidate)),
            text=True, capture_output=True, timeout=10)
        return result, destination, stage

    def testSuccessfulSwapRetainsPreviousApp(self):
        result, destination, stage = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((destination / "version").read_text(), "new")
        self.assertEqual((stage / "previous.app/version").read_text(), "old")

    def testMoveFailureRestoresOldApp(self):
        result, destination, _ = self.run_installer(fail_move=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((destination / "version").read_text(), "old")

    def testOpenFailureRestoresOldApp(self):
        result, destination, stage = self.run_installer(fail_open=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((destination / "version").read_text(), "old")
        self.assertEqual((stage / "failed.app/version").read_text(), "new")


if __name__ == "__main__":
    unittest.main()
