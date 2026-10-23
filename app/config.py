"""
VectorCore Configuration Manager
Strictly isolates system credentials, global parameters, and Drive mapping vectors.
"""

from typing import Any

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    APP_NAME: str = "VectorCore Security Suite"
    PORT: int = 8080
    HOST: str = "0.0.0.0"
    CACHE_TTL_SECONDS: int = 900  # 15 minutes

    # Official Drive Source Folders
    SENTIMENT_RCA_SOURCE: str = "1SRIpprdu3U8LKXj3w1JXiFdsNZ3U7CCx"
    SENTIMENT_RAW_SOURCE: str = "1G2djab7j-0MGTUOUcGQnrpiS6Khn1uCw"
    IRT_RAW_SOURCE: str = "1e6ctf0Ftx7wCdNXPBcqkmkIU5f09s0pU"
    ESC_RAW_SOURCE: str = "1QvaKqczLmiW3PNT1kYcMng58Yo0QXBDN"
    EFC_RAW_SOURCE: str = "1EuEWEmq8zBpk14ADJS5iOI2QLM46fq3n"

    @property
    def config_vectors(self) -> dict[str, dict[str, Any]]:
        return {
            "SENTIMENT_RCA": {
                "folder_id": self.SENTIMENT_RCA_SOURCE,
                "file_prefix": "sentiment_raw_",
            },
            "SENTIMENT_RAW": {
                "folder_id": self.SENTIMENT_RAW_SOURCE,
                "file_prefix": "sentiment_raw_",
            },
            "IRT_RAW": {
                "folder_id": self.IRT_RAW_SOURCE,
                "file_prefix": "irt_raw_",
            },
            "ESC_RAW": {
                "folder_id": self.ESC_RAW_SOURCE,
                "file_prefix": "esc_raw_",
            },
            "EFC_RAW": {
                "folder_id": self.EFC_RAW_SOURCE,
                "file_prefix": "efc_raw_",
            },
        }


# Instantiate the settings class globally so app.main can import it safely
settings = Settings()
