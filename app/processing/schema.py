"""
VectorCore Schema Catalog
Strict datatype declarations matching explicit corporate header rosters.
"""

from typing import Dict, Any
import pandas as pd

SCHEMA_CATALOG: Dict[str, Dict[str, str]] = {
    "sentiment_raw": {
        "Pod": "string",
        "Time Series Month": "string",
        "Time Series Week": "string",
        "Time Series Day": "string",
        "Product Sub Pod": "string",
        "Sales Service Region": "string",
        "Sales Service Market": "string",
        "Final Assignee Site": "string",
        "Frd Specialization Display String": "string",
        "Frd Inbound Communication Channel Display String": "string",
        "gCare Customer Segment (Final)": "string",
        "Final Assignee Username Masked": "string",
        "Support Cases Case Id": "string",
        "Sentiment Confidence": "string",
        "Case Sentiment Score (% Positive)": "double",
        "Sentiment DR": "double",
        "Cases Closed": "double",
        "Cases Opened": "double",
        "Average Time to First Response (TFR) (hours) (Email)": "double",
        "Average Time to First Response (TFR) (hours) (Email) Dr": "double",
        "Average Time to First Consult (hours)": "double",
        "Consult Average Interactions per Closed Case": "double",
        "Average Time in Assigned (hours)": "double",
        "Average Time in Assigned (hours) Dr": "double",
        "Average Time in Blocked By (hours)": "double",
        "Average Time in Blocked By (hours) Dr": "double",
        "Average Time in Need Info (hours)": "double",
        "Average Time in Need Info (hours) Dr": "double",
        "Average Time to First Assignment (TTA) (hours)": "double",
        "Average Time in Unassigned (hours)": "double",
        "Average Time in Unassigned (hours) Dr": "double",
        "Average Time to First Solution Offered (TFS) (hours)": "double",
        "Average Time to First Solution Offered (TFS) (hours) Dr": "double",
        "Average Time in New (hours)": "double",
        "Average Time in New (hours) Dr": "double",
        "Average Agent Time (hours)": "double",
        "Average Agent Time (hours) Dr": "double",
        "Average Interactions per Closed Case": "double",
        "Average Interactions per Closed Case Dr": "double",
        "Average Handle Time (AHT) (minutes)": "double",
        "Sentiment Explanation": "string"
    },
    "irt_raw": {
        "Pod": "string",
        "Time Series Month": "string",
        "Time Series Week": "string",
        "Time Series Day": "string",
        "Product Sub Pod": "string",
        "Sales Service Region": "string",
        "Sales Service Market": "string",
        "Final Assignee Site": "string",
        "Frd Specialization Display String": "string",
        "Frd Inbound Communication Channel Display String": "string",
        "Last Outgoing Or Synchronous Communication Channel": "string",
        "gCare Customer Segment (Final)": "string",
        "Final Assignee Username Masked": "string",
        "Support Cases Case Id": "string",
        "Reopen Driver": "string",
        "Cases Closed": "double",
        "Average Internal Resolution Time (IRT) (hours)": "double",
        "Average Internal Resolution Time (IRT) (hours) (Denominator)": "double",
        "Internal Resolution Time within 24h (IRT) (%)": "double",
        "Internal Resolution Time within 24h (IRT) (%) (Denominator)": "double",
        "Cases Reopened (%)": "double",
        "Cases Reopened (%) (Denominator)": "double",
        "Nautilus Case Summary": "string"
    },
    "esc_raw": {
        "Pod": "string",
        "Time Series Month": "string",
        "Time Series Week": "string",
        "Time Series Day": "string",
        "Product Sub Pod": "string",
        "Final Assignee Site": "string",
        "gCare Customer Segment (Final)": "string",
        "Sales Service Region": "string",
        "Sales Service Market": "string",
        "Frd Specialization Display String": "string",
        "Support Cases Case Id": "string",
        "Final Assignee Username Masked": "string",
        "Last Outgoing Or Synchronous Communication Channel": "string",
        "Frd Business Language Display String": "string",
        "Frd Inbound Communication Channel Display String": "string",
        "Escalations Opened": "double"
    },
    "efc_raw": {
        "POD": "string",
        "PoEFC_Num": "double",
        "PO EFC_Num": "double",
        "Qplus Review Month": "string",
        "Qplus Review Week": "string",
        "Qplus Review Date": "string",
        "gTech Ads Customer Segment": "string",
        "Client Assignment": "string",
        "Task Owner": "string",
        "Product Sub Pod": "string",
        "Sales Service Region": "string",
        "Sales Service Market": "string",
        "Opening Channel": "string",
        "Quality Reviewer": "string",
        "EFC%": "double",
        "Po EFC%": "double",
        "Quality Reviews": "double"
    }
}

def validate_dataframe(df: pd.DataFrame, table_name: str) -> pd.DataFrame:
    """Validates dataframe against schema catalog, sanitizing headers and datatypes."""
    if table_name not in SCHEMA_CATALOG:
        return df

    expected_schema = SCHEMA_CATALOG[table_name]
    cleaned_df = pd.DataFrame(index=df.index)

    # Standardize whitespace in incoming column names
    col_map = {str(c).strip().replace("🔑 ", ""): c for c in df.columns}

    for col, expected_type in expected_schema.items():
        lookup_col = col.replace("🔑 ", "")
        actual_col = col_map.get(lookup_col)

        if actual_col is not None:
            if col == "Support Cases Case Id":
                cleaned_df[col] = (
                    df[actual_col]
                    .astype(str)
                    .str.strip()
                    .str.replace(r'\.0$', '', regex=True)
                )
            elif expected_type == "double":
                cleaned_df[col] = pd.to_numeric(df[actual_col], errors="coerce").fillna(0.0)
            elif expected_type == "boolean":
                cleaned_df[col] = df[actual_col].map(
                    lambda x: True if str(x).lower() in ["true", "1", "yes"]
                    else (False if str(x).lower() in ["false", "0", "no"] else None)
                )
            else:
                cleaned_df[col] = df[actual_col].astype(str).str.strip()
        else:
            if expected_type == "double":
                cleaned_df[col] = 0.0
            elif expected_type == "boolean":
                cleaned_df[col] = None
            else:
                cleaned_df[col] = None

    return cleaned_df
