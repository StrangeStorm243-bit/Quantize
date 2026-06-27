"""The strategy evaluation schedule — a closed discriminated union.

Shaped so an ambiguous weekly/monthly schedule cannot be expressed: the only valid values are the
three ``kind`` variants below. Semantics (close of every session / last session of the week / last
session of the month) are defined in ``docs/STRATEGY_LANGUAGE.md`` §6.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field


class _ScheduleBase(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ScheduleDaily(_ScheduleBase):
    kind: Literal["daily"]


class ScheduleWeekly(_ScheduleBase):
    kind: Literal["weekly"]


class ScheduleMonthly(_ScheduleBase):
    kind: Literal["monthly"]


Schedule = Annotated[
    ScheduleDaily | ScheduleWeekly | ScheduleMonthly,
    Field(discriminator="kind"),
]
