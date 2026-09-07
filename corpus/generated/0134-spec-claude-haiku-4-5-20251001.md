# Technical Specification: StreamVault Media Storage Service

## Executive Summary

StreamVault is a distributed media storage and retrieval service designed to handle high-volume video content with intelligent tiering, transcoding support, and real-time access optimization. This specification outlines the core requirements, system architecture, and API design for version 2.1 of the platform.

> StreamVault prioritizes three core principles: reliability through geographic redundancy, cost efficiency via intelligent tiering, and user experience through sub-second retrieval times.

## 1. Requirements Overview

### 1.1 Functional Requirements

- **Content Ingestion**: Accept video uploads up to 500 GB per file with resumable transfer capability
- **Multi-Format Support**: Transcode content to 8 video formats and 3 audio profiles
- **Access Control**: Implement role-based and attribute-based access patterns
- **Search Capability**: Full-text search across metadata with latency < 200ms for 95th percentile
- **Lifecycle Management**: Automatic archival, retention policies, and deletion workflows
- **Replication**: Maintain 3 geographic copies with RPO of 4 hours and RTO of 15 minutes

### 1.2 Non-Functional Requirements

| Requirement | Target | Unit | Priority |
|---|---|---|---|
| Storage Capacity | 500 | PB | Critical |
| Read Throughput | 50,000 | req/s | Critical |
| Write Throughput | 5,000 | req/s | High |
| P99 Latency (Reads) | 150 | ms | Critical |
| Data Durability | 11-9s | nines | Critical |
| Availability | 4-9s | nines | High |
| Concurrent Users | 1,000,000 | simultaneous | High |
| Geographic Regions | 6 | regions | Medium |

### 1.3 Constraints

- Maximum file size: 500 GB (no multi-part threshold for files under 100 GB)
- Minimum supported video duration: 1 second
- Maximum retention period: 10 years
- Network bandwidth: limited to 1 Gbps per upload connection
- Transcode queue depth: maximum 10,000 pending jobs

## 2. System Architecture

### 2.1 Storage Tiers

StreamVault employs a three-tier storage strategy optimized by access patterns:

$$
\text{Total Cost} = (C_h \times S_h) + (C_w \times S_w) + (C_c \times S_c)
$$

Where:
- $C_h$ = cost per GB/month for hot storage ($0.032)
- $S_h$ = size in GB stored in hot tier
- $C_w$ = cost per GB/month for warm storage ($0.008)
- $S_w$ = size in GB stored in warm tier
- $C_c$ = cost per GB/month for cold storage ($0.002)
- $S_c$ = size in GB stored in cold tier

**Hot Tier** (0-30 days): High-speed SSD storage across multiple availability zones with automatic replication. Access latency: 5-50ms.

**Warm Tier** (31-180 days): Standard HDD storage with regional distribution. Suitable for content accessed 2-10 times per month. Retrieval time: 200-500ms.

**Cold Tier** (180+ days): Archival storage with geographic distribution across continents. Retrieval time: 1-24 hours based on restore priority.

### 2.2 Transcoding Pipeline

The transcoding system operates as a distributed job queue with priority-based processing:

```python
class TranscodeJob:
    def __init__(self, media_id: str, source_format: str):
        self.media_id = media_id
        self.source_format = source_format
        self.target_profiles = []
        self.priority = 5  # 1-10, higher is urgent
        self.status = "queued"
        self.created_at = datetime.utcnow()
        
    def add_profile(self, profile_name: str, bitrate: int):
        """Add a transcode target profile"""
        if bitrate < 128 or bitrate > 50000:
            raise ValueError("Bitrate must be 128-50000 kbps")
        self.target_profiles.append({
            "name": profile_name,
            "bitrate": bitrate
        })
    
    def estimate_duration_seconds(self) -> float:
        """Estimate processing time based on complexity"""
        base_time = 60  # minimum
        return base_time * len(self.target_profiles)
```

## 3. Data Model

### 3.1 Core Entities

**Media Object**
- Unique identifier (UUID v4)
- Original filename and MIME type
- Size in bytes
- Upload timestamp and completion timestamp
- Owner user ID
- Access control list
- Current storage tier
- Retention date
- Transcode profiles (array of completed profiles)

**Transcode Profile**
- Format identifier (e.g., "h264-aac-1080p")
- Codec specifications
- Bitrate (kbps)
- Resolution
- Frame rate
- Audio channels
- File size of output
- Creation timestamp

**Access Log**
- Media ID
- User ID or API key
- Access timestamp
- IP address
- User agent
- Bytes transferred
- HTTP status code
- Response time (ms)

### 3.2 Calculated Fields

The effective storage cost for media item $m$ can be expressed as:

$$
\text{CostPerMonth}(m) = \text{size}(m) \times \text{tier_cost}(\text{current_tier}(m))$$

Automatic tier transitions occur when: $\text{lastAccess}(m) > \text{threshold}(\text{current_tier})$

## 4. API Specification

### 4.1 Authentication & Authorization

All API endpoints require authentication via API key or OAuth 2.0 bearer token. Include credentials in the `Authorization` header:

```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

Rate limiting applies globally: 10,000 requests per minute per API key, with burst allowance of 500 requests per second.

### 4.2 Endpoints

#### Upload Media

**POST** `/v2/media/upload`

Initiate a resumable media upload session.

**Request Body:**
```json
{
  "filename": "conference_keynote.mp4",
  "size_bytes": 2147483648,
  "mime_type": "video/mp4",
  "retention_days": 365,
  "metadata": {
    "title": "Q3 Annual Conference",
    "speaker": "Dr. Elena Zhang",
    "tags": ["conference", "2024"]
  }
}
```

**Response (201 Created):**
```json
{
  "media_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "upload_url": "https://upload.streamvault.io/sessions/sess_9f8d7c6b5a4e3f",
  "session_id": "sess_9f8d7c6b5a4e3f",
  "expires_at": "2024-02-15T18:30:00Z",
  "chunk_size": 5242880,
  "max_chunks": 410
}
```

**Query Parameters:**
- `redundancy` (optional): "standard" (3 copies) or "premium" (5 copies)
- `target_region` (optional): Region hint for upload node selection

#### Retrieve Media

**GET** `/v2/media/{media_id}/download`

Download media content with optional format specification.

**Query Parameters:**
- `profile` (optional): Specific transcode profile ID
- `start_byte` (optional): Byte offset for range requests
- `end_byte` (optional): End byte for range requests

**Response Headers:**
```
Content-Type: video/mp4
Content-Length: 2147483648
Content-Disposition: attachment; filename="conference_keynote.mp4"
X-Media-Duration: 3600
X-Media-Bitrate: 6000
X-Stream-Source: hot-tier-usw2
```

**Status Codes:**
- `200 OK`: Successful retrieval
- `206 Partial Content`: Range request fulfilled
- `404 Not Found`: Media does not exist
- `410 Gone`: Media deleted or expired

#### Query Metadata

**GET** `/v2/media/{media_id}/metadata`

Retrieve complete metadata and transcode profile information.

**Response (200 OK):**
```json
{
  "media_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "filename": "conference_keynote.mp4",
  "size_bytes": 2147483648,
  "mime_type": "video/mp4",
  "created_at": "2024-02-01T10:15:30Z",
  "owner_id": "user_5d3c2b1a",
  "current_tier": "hot",
  "tier_transition_date": "2024-03-02T10:15:30Z",
  "retention_expires_at": "2025-02-01T10:15:30Z",
  "access_count": 1247,
  "last_accessed_at": "2024-02-14T16:45:20Z",
  "transcode_profiles": [
    {
      "profile_id": "prof_h264_720p",
      "format": "h264-aac-720p",
      "bitrate_kbps": 2500,
      "resolution": "1280x720",
      "file_size_bytes": 856603648,
      "created_at": "2024-02-01T11:30:15Z"
    }
  ]
}
```

#### List Media

**GET** `/v2/media`

List all media objects for the authenticated user with filtering and pagination.

**Query Parameters:**
- `limit` (default: 50, max: 500): Results per page
- `offset` (default: 0): Pagination offset
- `search` (optional): Full-text search query
- `tag` (optional, repeatable): Filter by tag
- `created_after` (optional): ISO 8601 timestamp
- `tier` (optional): Filter by storage tier ("hot", "warm", "cold")

#### Request Transcode

**POST** `/v2/media/{media_id}/transcode`

Submit a transcode job for an existing media object.

**Request Body:**
```json
{
  "profiles": [
    {
      "format": "h264-aac-1080p",
      "bitrate_kbps": 5000
    },
    {
      "format": "h264-aac-720p",
      "bitrate_kbps": 2500
    },
    {
      "format": "vp9-opus-4k",
      "bitrate_kbps": 12000
    }
  ],
  "priority": 7,
  "notify_on_complete": "https://webhook.example.com/transcode-callback"
}
```

**Response (202 Accepted):**
```json
{
  "transcode_job_id": "job_7f6e5d4c3b2a1f",
  "media_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "status": "queued",
  "queue_position": 324,
  "estimated_completion": "2024-02-15T14:30:00Z",
  "profiles_requested": 3
}
```

#### Get Transcode Status

**GET** `/v2/transcode/{job_id}`

Poll the status of an ongoing transcode operation.

**Response (200 OK):**
```json
{
  "transcode_job_id": "job_7f6e5d4c3b2a1f",
  "status": "processing",
  "progress_percent": 45,
  "profiles": [
    {
      "profile": "h264-aac-1080p",
      "status": "completed",
      "file_size_bytes": 1892436184
    },
    {
      "profile": "h264-aac-720p",
      "status": "in_progress",
      "progress_percent": 92
    },
    {
      "profile": "vp9-opus-4k",
      "status": "pending"
    }
  ]
}
```

#### Delete Media

**DELETE** `/v2/media/{media_id}`

Permanently delete a media object and all associated transcode profiles.

**Query Parameters:**
- `immediate` (optional, boolean): Skip grace period (default: false)

**Response (204 No Content)**

**Grace Period:** By default, deleted media enters a 30-day recovery window. Set `immediate=true` to bypass.

## 5. Implementation Roadmap

- [ ] Core upload and download endpoints
- [x] Authentication and authorization framework
- [x] Database schema design
- [ ] Transcoding pipeline implementation
- [ ] Hot/warm/cold tier migration logic
- [ ] Monitoring and alerting system
- [ ] Webhook notification system
- [ ] Full-text search indexing
- [ ] Geographic replication controller
- [ ] Admin dashboard

## 6. Performance Targets

Expected throughput on a standard deployment with 100 compute nodes:

- Write throughput: 5,000 objects/second
- Read throughput: 50,000 objects/second
- Transcode capacity: 2,000 hours of video per day
- Metadata query latency: < 200ms (p99)
- Media download latency: < 150ms (p99)

---

**Document Version:** 2.1  
**Last Updated:** 2024-02-14  
**Author:** Architecture Team  
**Status:** Final Review
