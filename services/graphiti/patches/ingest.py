"""Bounded tori-local Graphiti ingest patch for zepai/graphiti 0.30.2.

The upstream 0.30.2 API queues /messages work onto an AsyncWorker that is not
started by the app lifespan, and the queued closure captures a request-scoped
Graphiti client that FastAPI closes as soon as the 202 response is returned.
That combination accepts writes and then drops them on the floor.

For Ben's private tori-local deployment we keep the existing raw API surface
loopback-only, but make curated ingest deterministic by processing /messages
synchronously and by adding a small /episodes alias that matches the reviewed
agent wrapper payload.  This file is bind-mounted read-only over
/app/graph_service/routers/ingest.py; it does not modify the image contents.
"""

from datetime import datetime
from typing import Literal

from fastapi import APIRouter, status
from graphiti_core.nodes import EpisodeType  # type: ignore
from graphiti_core.utils.maintenance.graph_data_operations import clear_data  # type: ignore
from pydantic import BaseModel, Field

from graph_service.dto import AddEntityNodeRequest, AddMessagesRequest, Message, Result
from graph_service.zep_graphiti import ZepGraphitiDep

router = APIRouter()


class AddEpisodeRequest(BaseModel):
    """Minimal episode payload used by the curated ingest wrapper."""

    name: str = Field(..., description="The episode name")
    episode_body: str = Field(..., description="The curated episode text")
    source: Literal["message", "json", "text", "fact_triple"] = Field(
        default="text", description="Graphiti episode source type"
    )
    source_description: str = Field(default="", description="Provenance/source description")
    group_id: str | None = Field(default=None, description="Graph partition/group id")
    reference_time: datetime = Field(..., description="Episode reference timestamp")
    uuid: str | None = Field(default=None, description="Optional episode UUID")


async def _add_message(graphiti, group_id: str, m: Message):
    return await graphiti.add_episode(
        uuid=m.uuid,
        group_id=group_id,
        name=m.name,
        episode_body=f'{m.role or ""}({m.role_type}): {m.content}',
        reference_time=m.timestamp,
        source=EpisodeType.message,
        source_description=m.source_description,
    )


@router.post('/messages', status_code=status.HTTP_201_CREATED)
async def add_messages(
    request: AddMessagesRequest,
    graphiti: ZepGraphitiDep,
):
    """Synchronously ingest message episodes.

    Upstream returned 202 before the queued work could run.  Returning only after
    add_episode completes gives callers a real write result and lets smoke tests
    prove ingestion rather than queue theater.
    """

    for m in request.messages:
        await _add_message(graphiti, request.group_id, m)

    return Result(message='Messages ingested', success=True)


@router.post('/episodes', status_code=status.HTTP_201_CREATED)
async def add_episode(
    request: AddEpisodeRequest,
    graphiti: ZepGraphitiDep,
):
    source = EpisodeType.from_str(request.source)
    await graphiti.add_episode(
        uuid=request.uuid,
        name=request.name,
        episode_body=request.episode_body,
        source_description=request.source_description,
        reference_time=request.reference_time,
        source=source,
        group_id=request.group_id,
    )
    return Result(message='Episode ingested', success=True)


@router.post('/entity-node', status_code=status.HTTP_201_CREATED)
async def add_entity_node(
    request: AddEntityNodeRequest,
    graphiti: ZepGraphitiDep,
):
    node = await graphiti.save_entity_node(
        uuid=request.uuid,
        group_id=request.group_id,
        name=request.name,
        summary=request.summary,
    )
    return node


@router.delete('/entity-edge/{uuid}', status_code=status.HTTP_200_OK)
async def delete_entity_edge(uuid: str, graphiti: ZepGraphitiDep):
    await graphiti.delete_entity_edge(uuid)
    return Result(message='Entity Edge deleted', success=True)


@router.delete('/group/{group_id}', status_code=status.HTTP_200_OK)
async def delete_group(group_id: str, graphiti: ZepGraphitiDep):
    await graphiti.delete_group(group_id)
    return Result(message='Group deleted', success=True)


@router.delete('/episode/{uuid}', status_code=status.HTTP_200_OK)
async def delete_episode(uuid: str, graphiti: ZepGraphitiDep):
    await graphiti.delete_episodic_node(uuid)
    return Result(message='Episode deleted', success=True)


@router.post('/clear', status_code=status.HTTP_200_OK)
async def clear(
    graphiti: ZepGraphitiDep,
):
    await clear_data(graphiti.driver)
    await graphiti.build_indices_and_constraints()
    return Result(message='Graph cleared', success=True)
