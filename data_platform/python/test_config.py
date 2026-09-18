from __future__ import annotations

import unittest

from .config import load_environment


class EnvironmentTest(unittest.TestCase):
    def test_matches_local_defaults_and_scope_contract(self):
        environment = load_environment({})
        self.assertEqual(environment.api_token, "local-dev-token")
        self.assertEqual(environment.api_tenant_id, "tenant_local")
        self.assertEqual(environment.api_actor_id, "operator_local")
        self.assertEqual(environment.api_scopes, ("control_tower:read", "control_tower:write"))
        self.assertEqual(environment.max_body_bytes, 2 * 1024 * 1024)

    def test_requires_secure_production_token(self):
        with self.assertRaisesRegex(ValueError, "CONTROL_TOWER_API_TOKEN é obrigatório"):
            load_environment({"NODE_ENV": "production"})

    def test_rejects_short_production_token(self):
        with self.assertRaisesRegex(ValueError, "pelo menos 32 caracteres"):
            load_environment({"NODE_ENV": "production", "CONTROL_TOWER_API_TOKEN": "short", "DATABASE_URL": "postgresql://db", "CONTROL_TOWER_API_TENANT_ID": "tenant", "CONTROL_TOWER_API_ACTOR_ID": "actor"})
