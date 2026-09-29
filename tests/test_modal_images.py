"""Exercise Modal's deferred image-order guard without a paid cloud build."""

import importlib
from unittest.mock import patch

import pytest
from modal._image import _Image
from modal.exception import InvalidError


@pytest.fixture
def validate_image_layers_early():
    original = _Image._from_args
    original_mount = _Image._add_mount_layer_or_copy

    def mount_early(self, mount, copy=False):
        result = original_mount(self, mount, copy=copy)
        if not copy:
            # Simulate the mount state normally set during remote hydration.
            result._deferred_mounts = tuple(self._deferred_mounts) + (mount,)
        return result

    def checked_from_args(**kwargs):
        # SDK 1.5.5 normally calls this guard in its remote image loader.
        # Call the same guard at construction time to catch failures locally.
        if kwargs.get('_do_assert_no_mount_layers', True):
            for base in (kwargs.get('base_images') or {}).values():
                base._assert_no_mount_layers()
        return original(**kwargs)

    with (
        patch.object(_Image, '_from_args', staticmethod(checked_from_args)),
        patch.object(_Image, '_add_mount_layer_or_copy', mount_early),
    ):
        yield


def test_deployment_images_pass_modal_mount_order_guard(validate_image_layers_early):
    module = importlib.import_module('demo.modal_app')
    importlib.reload(module)


def test_guard_rejects_install_after_local_source(validate_image_layers_early):
    with pytest.raises(InvalidError, match='build step after'):
        (_Image.debian_slim(python_version='3.12')
         .add_local_python_source('demo')
         .pip_install('huggingface-hub==1.32.0'))
