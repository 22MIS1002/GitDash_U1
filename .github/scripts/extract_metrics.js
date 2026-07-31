const fs = require('fs');

async function run() {
  const token = process.env.GITHUB_TOKEN;
  const startDate = process.env.START_DATE;
  const endDate = process.env.END_DATE;

  if (!startDate || !endDate) {
    throw new Error("START_DATE and END_DATE inputs are required.");
  }

  const dateRangeTag = `${startDate}_to_${endDate}`;
  const repository = process.env.GITHUB_REPOSITORY; // "owner/repo"

  // --- CONFIGURATION ---
  const PROJECT_ID = "PVT_kwHOCbDnFc4Be6cg"; 

  const FIELD_IDS = {
    jiraItems:      "PVTF_lAHOCbDnFc4Be6cgzhZRL4U",
    taskType:       "PVTF_lAHOCbDnFc4Be6cgzhZRMEk",
    prId:           "PVTF_lAHOCbDnFc4Be6cgzhZRMQM",
    prTitle:        "PVTF_lAHOCbDnFc4Be6cgzhZRMpc",
    prDesc:         "PVTF_lAHOCbDnFc4Be6cgzhZRMx4",
    reviewComments: "PVTF_lAHOCbDnFc4Be6cgzhZRM20",
    botComments:    "PVTF_lAHOCbDnFc4Be6cgzhZRnTo",
    prDefects:      "PVTF_lAHOCbDnFc4Be6cgzhZRgsw",
    dateRange:      "PVTF_lAHOCbDnFc4Be6cgzhZVWCo",
    prStatus:       "PVTSSF_lAHOCbDnFc4Be6cgzhZVWwU"
  };

  const PR_STATUS_OPTIONS = {
    OPEN:   "a169abfa",
    MERGED: "c29cb3fa",
    CLOSED: "e18667b6"
  };
  // ---------------------

  // GraphQL Helper
  async function graphqlQuery(query, variables) {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        "Authorization": `bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query, variables })
    });
    const json = await res.json();
    if (json.errors) {
      console.error("GraphQL Errors:", JSON.stringify(json.errors, null, 2));
    }
    return json.data;
  }

  // 1. Lightweight Search Query (Avoids Node Limit Exceeded)
  const searchQuery = `
    query($searchQuery: String!) {
      search(query: $searchQuery, type: ISSUE, first: 100) {
        nodes {
          ... on PullRequest {
            id
            number
            title
            body
            state
            merged
            labels(first: 10) {
              nodes { name }
            }
          }
        }
      }
    }
  `;

  const searchFilter = `is:pr repo:${repository} created:${startDate}..${endDate}`;
  console.log(`Executing Search: ${searchFilter}`);

  const searchData = await graphqlQuery(searchQuery, { searchQuery: searchFilter });
  const pullRequests = searchData?.search?.nodes || [];

  console.log(`Found ${pullRequests.length} PRs created between ${startDate} and ${endDate}.`);

  // Helper function to update board fields safely
  async function updateField(itemId, fieldId, value, valueType) {
    const updateMutation = `
      mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $projectId,
          itemId: $itemId,
          fieldId: $fieldId,
          value: $value
        }) {
          projectV2Item { id }
        }
      }
    `;
    
    let fieldValue = {};
    if (valueType === 'text') fieldValue = { text: String(value) };
    if (valueType === 'number') fieldValue = { number: Number(value) };
    if (valueType === 'singleSelect') fieldValue = { singleSelectOptionId: String(value) };

    try {
      await graphqlQuery(updateMutation, {
        projectId: PROJECT_ID,
        itemId: itemId,
        fieldId: fieldId,
        value: fieldValue
      });
    } catch (e) {
      console.error(`Failed updating field ${fieldId}:`, e);
    }
  }

  // PR Comments Fetch Query
  const commentsQuery = `
    query($prNodeId: ID!) {
      node(id: $prNodeId) {
        ... on PullRequest {
          comments(first: 100) {
            nodes { author { login } }
          }
          reviews(first: 100) {
            nodes {
              comments(first: 100) {
                nodes { author { login } }
              }
            }
          }
        }
      }
    }
  `;

  // 2. Loop through matched PRs and populate board
  for (const pr of pullRequests) {
    if (!pr.id) continue;

    console.log(`Processing PR #${pr.number}: ${pr.title}`);

    // Determine PR Status
    let prStatusKey = pr.state; // OPEN or CLOSED
    if (pr.merged) prStatusKey = "MERGED";
    const prStatusOptionId = PR_STATUS_OPTIONS[prStatusKey];

    // Task Type / Labels
    const labels = (pr.labels?.nodes || []).map(l => l.name);
    const taskType = labels.length > 0 ? labels.join(", ") : "Unlabeled";

    // JIRA Key Extraction
    const prTitleText = pr.title || "";
    const prBodyText = pr.body || "";
    const jiraRegex = /([A-Z]{2,}-\d+)/g;
    const jiraMatches = (prTitleText + " " + prBodyText).match(jiraRegex);
    const jiraId = jiraMatches ? [...new Set(jiraMatches)].join(", ") : "N/A";

    // Fetch PR Comments & Reviews individually
    const detailsData = await graphqlQuery(commentsQuery, { prNodeId: pr.id });
    const prDetails = detailsData?.node || {};

    let botCommentCount = 0;
    let humanReviewCommentCount = 0;

    (prDetails.comments?.nodes || []).forEach(c => {
      if (c.author?.login?.includes('[bot]') || c.author?.login === 'github-actions') {
        botCommentCount++;
      }
    });

    (prDetails.reviews?.nodes || []).forEach(r => {
      (r.comments?.nodes || []).forEach(rc => {
        if (rc.author?.login?.includes('[bot]') || rc.author?.login === 'github-actions') {
          botCommentCount++;
        } else {
          humanReviewCommentCount++;
        }
      });
    });

    // Add PR to Project Board
    const addItemMutation = `
      mutation($projectId: ID!, $contentId: ID!) {
        addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) {
          item { id }
        }
      }
    `;
    const addItemData = await graphqlQuery(addItemMutation, { projectId: PROJECT_ID, contentId: pr.id });
    const itemId = addItemData?.addProjectV2ItemById?.item?.id;

    if (!itemId) {
      console.error(`Failed to add PR #${pr.number} to board.`);
      continue;
    }

    // Populate Fields
    await updateField(itemId, FIELD_IDS.jiraItems, jiraId, 'text');
    await updateField(itemId, FIELD_IDS.taskType, taskType, 'text');
    await updateField(itemId, FIELD_IDS.prId, pr.number, 'number');
    await updateField(itemId, FIELD_IDS.prTitle, prTitleText || "No Title", 'text');
    await updateField(itemId, FIELD_IDS.prDesc, prBodyText || "No Description", 'text');
    await updateField(itemId, FIELD_IDS.reviewComments, humanReviewCommentCount, 'number');
    await updateField(itemId, FIELD_IDS.botComments, botCommentCount, 'number');
    await updateField(itemId, FIELD_IDS.prDefects, 0, 'number');
    await updateField(itemId, FIELD_IDS.dateRange, dateRangeTag, 'text');
    
    if (prStatusOptionId) {
      await updateField(itemId, FIELD_IDS.prStatus, prStatusOptionId, 'singleSelect');
    }
  }

  console.log("Finished populating date-ranged PR metrics to Project V2!");
}

run().catch(err => {
  console.error("Workflow failed:", err);
  process.exit(1);
});

// /=====================================================================

// const fs = require('fs');

// async function run() {
//   const token = process.env.GITHUB_TOKEN;
//   const startDate = process.env.START_DATE;
//   const endDate = process.env.END_DATE;

//   if (!startDate || !endDate) {
//     throw new Error("START_DATE and END_DATE inputs are required.");
//   }

//   const dateRangeTag = `${startDate}_to_${endDate}`;
//   const repository = process.env.GITHUB_REPOSITORY; // "owner/repo"

//   // --- CONFIGURATION ---
//   const PROJECT_ID = "PVT_kwHOCbDnFc4Be6cg"; 

//   const FIELD_IDS = {
//     jiraItems:      "PVTF_lAHOCbDnFc4Be6cgzhZRL4U",
//     taskType:       "PVTF_lAHOCbDnFc4Be6cgzhZRMEk",
//     prId:           "PVTF_lAHOCbDnFc4Be6cgzhZRMQM",
//     prTitle:        "PVTF_lAHOCbDnFc4Be6cgzhZRMpc",
//     prDesc:         "PVTF_lAHOCbDnFc4Be6cgzhZRMx4",
//     reviewComments: "PVTF_lAHOCbDnFc4Be6cgzhZRM20",
//     botComments:    "PVTF_lAHOCbDnFc4Be6cgzhZRnTo",
//     prDefects:      "PVTF_lAHOCbDnFc4Be6cgzhZRgsw",
//     dateRange:      "PVTF_lAHOCbDnFc4Be6cgzhZVWCo",  // New Text Field ID
//     prStatus:       "PVTSSF_lAHOCbDnFc4Be6cgzhZVWwU"    // New Single Select Field ID
//   };

//   // Option IDs for PR Status Single Select Field
//   const PR_STATUS_OPTIONS = {
//     OPEN:   "a169abfa",
//     MERGED: "c29cb3fa",
//     CLOSED: "e18667b6"
//   };
//   // ---------------------

//   // GraphQL Helper
//   async function graphqlQuery(query, variables) {
//     const res = await fetch("https://api.github.com/graphql", {
//       method: "POST",
//       headers: {
//         "Authorization": `bearer ${token}`,
//         "Content-Type": "application/json"
//       },
//       body: JSON.stringify({ query, variables })
//     });
//     const json = await res.json();
//     if (json.errors) {
//       console.error("GraphQL Errors:", JSON.stringify(json.errors, null, 2));
//     }
//     return json.data;
//   }

//   // 1. Search PRs within Date Range
//   const searchQuery = `
//     query($searchQuery: String!) {
//       search(query: $searchQuery, type: ISSUE, first: 100) {
//         nodes {
//           ... on PullRequest {
//             id
//             number
//             title
//             body
//             state
//             merged
//             labels(first: 10) {
//               nodes { name }
//             }
//             comments(first: 100) {
//               nodes {
//                 author { login }
//               }
//             }
//             reviews(first: 100) {
//               nodes {
//                 comments(first: 100) {
//                   nodes {
//                     author { login }
//                   }
//                 }
//               }
//             }
//           }
//         }
//       }
//     }
//   `;

//   const searchFilter = `is:pr repo:${repository} created:${startDate}..${endDate}`;
//   console.log(`Executing Search: ${searchFilter}`);

//   const searchData = await graphqlQuery(searchQuery, { searchQuery: searchFilter });
//   const pullRequests = searchData?.search?.nodes || [];

//   console.log(`Found ${pullRequests.length} PRs created between ${startDate} and ${endDate}.`);

//   // Helper function to update board fields safely
//   async function updateField(itemId, fieldId, value, valueType) {
//     const updateMutation = `
//       mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
//         updateProjectV2ItemFieldValue(input: {
//           projectId: $projectId,
//           itemId: $itemId,
//           fieldId: $fieldId,
//           value: $value
//         }) {
//           projectV2Item { id }
//         }
//       }
//     `;
    
//     let fieldValue = {};
//     if (valueType === 'text') fieldValue = { text: String(value) };
//     if (valueType === 'number') fieldValue = { number: Number(value) };
//     if (valueType === 'singleSelect') fieldValue = { singleSelectOptionId: String(value) };

//     try {
//       await graphqlQuery(updateMutation, {
//         projectId: PROJECT_ID,
//         itemId: itemId,
//         fieldId: fieldId,
//         value: fieldValue
//       });
//     } catch (e) {
//       console.error(`Failed updating field ${fieldId}:`, e);
//     }
//   }

//   // 2. Loop through matched PRs and populate board
//   for (const pr of pullRequests) {
//     if (!pr.id) continue;

//     console.log(`Processing PR #${pr.number}: ${pr.title}`);

//     // Determine PR Status
//     let prStatusKey = pr.state; // OPEN or CLOSED
//     if (pr.merged) prStatusKey = "MERGED";
//     const prStatusOptionId = PR_STATUS_OPTIONS[prStatusKey];

//     // Task Type / Labels
//     const labels = (pr.labels?.nodes || []).map(l => l.name);
//     const taskType = labels.length > 0 ? labels.join(", ") : "Unlabeled";

//     // JIRA Key Extraction
//     const prTitleText = pr.title || "";
//     const prBodyText = pr.body || "";
//     const jiraRegex = /([A-Z]{2,}-\d+)/g;
//     const jiraMatches = (prTitleText + " " + prBodyText).match(jiraRegex);
//     const jiraId = jiraMatches ? [...new Set(jiraMatches)].join(", ") : "N/A";

//     // Count Comments
//     let botCommentCount = 0;
//     let humanReviewCommentCount = 0;

//     (pr.comments?.nodes || []).forEach(c => {
//       if (c.author?.login?.includes('[bot]') || c.author?.login === 'github-actions') {
//         botCommentCount++;
//       }
//     });

//     (pr.reviews?.nodes || []).forEach(r => {
//       (r.comments?.nodes || []).forEach(rc => {
//         if (rc.author?.login?.includes('[bot]') || rc.author?.login === 'github-actions') {
//           botCommentCount++;
//         } else {
//           humanReviewCommentCount++;
//         }
//       });
//     });

//     // Add PR to Project Board
//     const addItemMutation = `
//       mutation($projectId: ID!, $contentId: ID!) {
//         addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) {
//           item { id }
//         }
//       }
//     `;
//     const addItemData = await graphqlQuery(addItemMutation, { projectId: PROJECT_ID, contentId: pr.id });
//     const itemId = addItemData?.addProjectV2ItemById?.item?.id;

//     if (!itemId) {
//       console.error(`Failed to add PR #${pr.number} to board.`);
//       continue;
//     }

//     // Populate Fields
//     await updateField(itemId, FIELD_IDS.jiraItems, jiraId, 'text');
//     await updateField(itemId, FIELD_IDS.taskType, taskType, 'text');
//     await updateField(itemId, FIELD_IDS.prId, pr.number, 'number');
//     await updateField(itemId, FIELD_IDS.prTitle, prTitleText || "No Title", 'text');
//     await updateField(itemId, FIELD_IDS.prDesc, prBodyText || "No Description", 'text');
//     await updateField(itemId, FIELD_IDS.reviewComments, humanReviewCommentCount, 'number');
//     await updateField(itemId, FIELD_IDS.botComments, botCommentCount, 'number');
//     await updateField(itemId, FIELD_IDS.prDefects, 0, 'number');
//     await updateField(itemId, FIELD_IDS.dateRange, dateRangeTag, 'text');
    
//     if (prStatusOptionId) {
//       await updateField(itemId, FIELD_IDS.prStatus, prStatusOptionId, 'singleSelect');
//     }
//   }

//   console.log("Finished populating date-ranged PR metrics to Project V2!");
// }

// run().catch(err => {
//   console.error("Workflow failed:", err);
//   process.exit(1);
// });