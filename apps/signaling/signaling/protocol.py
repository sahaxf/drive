"""
Wire format shared with the browser side (packages/shared/src/controller.ts). Keep the
two in sync: room codes, message shapes and the HTTP request/response bodies.
"""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

# Room codes avoid look-alike characters (0/O, 1/I/L) so they can be typed from the screen.
ROOM_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
ROOM_CODE_LENGTH = 4

# An SDP for one data channel is a few kB; anything far bigger isn't from our pages.
MAX_SDP_LENGTH = 16_000

Role = Literal["host", "pad"]


def is_room_code(value: str) -> bool:
    return len(value) == ROOM_CODE_LENGTH and all(c in ROOM_ALPHABET for c in value)


# --- WebRTC signalling, the only thing passed between game and phone -------------------


class IceCandidate(BaseModel):
    """RTCIceCandidateInit, passed on as the browser produced it."""

    model_config = ConfigDict(extra="allow")

    candidate: str = Field(max_length=1_000)
    sdpMid: str | None = None
    sdpMLineIndex: int | None = None
    usernameFragment: str | None = None


class RtcOffer(BaseModel):
    t: Literal["rtc-offer"]
    sdp: str = Field(max_length=MAX_SDP_LENGTH)


class RtcAnswer(BaseModel):
    t: Literal["rtc-answer"]
    sdp: str = Field(max_length=MAX_SDP_LENGTH)


class RtcIce(BaseModel):
    t: Literal["rtc-ice"]
    candidate: IceCandidate


RtcMessage = Annotated[RtcOffer | RtcAnswer | RtcIce, Field(discriminator="t")]


# --- HTTP bodies ------------------------------------------------------------------------


class HostJoinRequest(BaseModel):
    # The code a reloading game had before, so a paired phone stays paired. Empty for a new room.
    room: str = ""


class HostJoinResponse(BaseModel):
    code: str
    peer: str
    # Addresses of this machine a phone on the LAN might reach, best guess first.
    lanAddresses: list[str]


class PadJoinRequest(BaseModel):
    room: str


class PadJoinResponse(BaseModel):
    peer: str


class SendRequest(BaseModel):
    peer: str
    message: RtcMessage


class LeaveRequest(BaseModel):
    peer: str


class PollResponse(BaseModel):
    # Notices from the server ({"t": "peer"|"replaced"}) and signalling from the other side.
    messages: list[dict]
