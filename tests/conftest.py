import shutil
import tarfile
from pathlib import Path

import pytest

from fairfax_financial.core import Settings
from fairfax_financial.pipeline import Pipeline
from fairfax_financial.storage import Objects


@pytest.fixture(scope="session")
def fixture_root(tmp_path_factory):
    root = tmp_path_factory.mktemp("real-sec-fixture")
    (root / "raw").mkdir()
    with tarfile.open(Path(__file__).parent / "fixtures/sec-pilot.tar.gz") as archive:
        archive.extractall(root / "raw", filter="data")
    yield root
    shutil.rmtree(root, ignore_errors=True)


@pytest.fixture(scope="session")
def real_raw(fixture_root):
    return Objects(Settings(fixture_root))


@pytest.fixture(scope="session")
def real_pipeline(fixture_root, tmp_path_factory):
    root = tmp_path_factory.mktemp("rebuild")
    shutil.copytree(fixture_root / "raw", root / "raw")
    yield Pipeline(Settings(root))
    shutil.rmtree(root, ignore_errors=True)


@pytest.fixture(autouse=True)
def cleanup_test_directory(tmp_path):
    yield
    shutil.rmtree(tmp_path, ignore_errors=True)
