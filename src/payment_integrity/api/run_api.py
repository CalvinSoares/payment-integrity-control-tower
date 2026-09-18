"""Local entrypoint for the package-based API."""

from __future__ import annotations

import os

import uvicorn


if __name__ == "__main__":
    uvicorn.run(
        "payment_integrity.api.app:app",
        host=os.getenv("CONTROL_TOWER_API_HOST", "127.0.0.1"),
        port=int(os.getenv("CONTROL_TOWER_PYTHON_API_PORT", "4200")),
        reload=False,
    )
