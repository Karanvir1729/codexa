from __future__ import annotations

from pathlib import Path
from typing import Any

from .db import Database, loads


def export_sft_jsonl(db: Database, output_path: str | Path) -> dict[str, Any]:
    """Export high-signal turns into JSONL suitable for LoRA/SFT curation.

    The export includes positive live feedback and passing eval cases. It avoids
    treating every transcript as training data, because low-quality production
    calls should first become eval failures or negative feedback.
    """

    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    rows = db.all(
        """
        SELECT t.conversation_id, t.content, t.prompt_version
        FROM turns t
        JOIN feedback f ON f.turn_id = t.id
        WHERE t.role = 'assistant' AND f.rating >= 4
        ORDER BY t.created_at ASC
        """
    )
    eval_rows = db.all(
        """
        SELECT transcript_json
        FROM eval_results
        WHERE passed = 1
        ORDER BY created_at ASC
        """
    )

    examples: list[dict[str, Any]] = []
    for row in rows:
        transcript = db.all(
            """
            SELECT role, content
            FROM turns
            WHERE conversation_id = ? AND role IN ('user', 'assistant')
            ORDER BY created_at ASC
            """,
            (row["conversation_id"],),
        )
        examples.append(
            {
                "messages": [
                    {"role": turn["role"], "content": turn["content"]} for turn in transcript
                ],
                "metadata": {
                    "source": "live_feedback",
                    "prompt_version": row["prompt_version"],
                },
            }
        )

    for row in eval_rows:
        examples.append(
            {
                "messages": loads(row["transcript_json"], []),
                "metadata": {"source": "passing_eval"},
            }
        )

    with output.open("w", encoding="utf-8") as handle:
        for example in examples:
            import json

            handle.write(json.dumps(example, ensure_ascii=False) + "\n")

    return {"path": str(output), "examples": len(examples)}

