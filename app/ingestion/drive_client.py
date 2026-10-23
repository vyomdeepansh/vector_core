"""
VectorCore Google Drive Service Client
Manages secure corporate file discovery and media stream loading.
"""

import io

from google.auth import default
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload


class DriveClient:
    def __init__(self):
        # Authenticates securely using standard corporate workstation credentials
        self.credentials, _ = default()
        self.service = build("drive", "v3", credentials=self.credentials)

    def download_csv_stream(self, file_id: str) -> io.BytesIO:
        """Downloads a target CSV directly into an in-memory byte buffer."""
        request = self.service.files().get_media(fileId=file_id)
        file_stream = io.BytesIO()
        downloader = MediaIoBaseDownload(file_stream, request)

        done = False
        while not done:
            _, done = downloader.next_chunk()

        file_stream.seek(0)
        return file_stream
