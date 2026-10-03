"""The runner treats keyboard substitutes (ae/oe/ue/plain vowels, ss for ß) as correct.
This checks the folding rule that backs that up, by running it in node."""
import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
node = shutil.which("node")


def fold_equal(pairs):
    js = (ROOT / "web" / "game.js").read_text(encoding="utf-8")
    fold = re.search(r"const fold = [\s\S]*?\.trim\(\);", js).group(0)
    code = fold + f"\nconst pairs = {json.dumps(pairs)};\nconsole.log(JSON.stringify(pairs.map(([a, b]) => fold(a) === fold(b))));"
    out = subprocess.run([node, "-e", code], capture_output=True, text=True, check=True).stdout
    return json.loads(out)


@pytest.mark.skipif(node is None, reason="node not installed")
def test_keyboard_substitutes_are_equal():
    same = [("fuer", "für"), ("Baeckerei", "Bäckerei"), ("Strasse", "Straße"), ("gross", "groß"),
            ("uber", "über"), ("schon", "schön"), ("Oel", "Öl"), ("Aerger", "Ärger")]
    assert all(fold_equal(same))


@pytest.mark.skipif(node is None, reason="node not installed")
def test_real_mistakes_are_not_hidden():
    different = [("Brod", "Brot"), ("habe gefahren", "bin gefahren"), ("ist", "isst"),
                 ("den Mann", "dem Mann"), ("Hunt", "Hund")]
    assert not any(fold_equal(different))
