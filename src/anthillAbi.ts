export const anthillAbi = [
  {
    type: "constructor",
    inputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "MAX_REL_ROOT_DEPTH",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "addDagVote",
    inputs: [
      {
        name: "voter",
        type: "address",
        internalType: "address",
      },
      {
        name: "recipient",
        type: "address",
        internalType: "address",
      },
      {
        name: "weight",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "balanceOf",
    inputs: [
      {
        name: "voter",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "calculateReputation",
    inputs: [
      {
        name: "voter",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "calculateReputationIterative",
    inputs: [
      {
        name: "voter",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "calculatedReputationForEpoch",
    inputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "changeName",
    inputs: [
      {
        name: "voter",
        type: "address",
        internalType: "address",
      },
      {
        name: "voterName",
        type: "string",
        internalType: "string",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "decimalPoint",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "decimals",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "findDistAtSameDepth",
    inputs: [
      {
        name: "add1",
        type: "address",
        internalType: "address",
      },
      {
        name: "add2",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "isSameDepth",
        type: "bool",
        internalType: "bool",
      },
      {
        name: "distance",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "findDistances",
    inputs: [
      {
        name: "voter",
        type: "address",
        internalType: "address",
      },
      {
        name: "recipient",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "isLocalEitherWay",
        type: "bool",
        internalType: "bool",
      },
      {
        name: "sDist",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "rDist",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "findDistancesRecNotLower",
    inputs: [
      {
        name: "voter",
        type: "address",
        internalType: "address",
      },
      {
        name: "recipient",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "isLocal",
        type: "bool",
        internalType: "bool",
      },
      {
        name: "sDist",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "rDist",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "findNthParent",
    inputs: [
      {
        name: "voter",
        type: "address",
        internalType: "address",
      },
      {
        name: "height",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "parent",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "findRecDagVote",
    inputs: [
      {
        name: "voter",
        type: "address",
        internalType: "address",
      },
      {
        name: "recipient",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "votable",
        type: "bool",
        internalType: "bool",
      },
      {
        name: "voted",
        type: "bool",
        internalType: "bool",
      },
      {
        name: "sdist",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "depth",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "votePos",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "dagVote",
        type: "tuple",
        internalType: "struct DagVote",
        components: [
          {
            name: "id",
            type: "address",
            internalType: "address",
          },
          {
            name: "weight",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "dist",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "posInOther",
            type: "uint256",
            internalType: "uint256",
          },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "findRecDagVoteNew",
    inputs: [
      {
        name: "voter",
        type: "address",
        internalType: "address",
      },
      {
        name: "recipient",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "votable",
        type: "bool",
        internalType: "bool",
      },
      {
        name: "voted",
        type: "bool",
        internalType: "bool",
      },
      {
        name: "votePos",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "dagVote",
        type: "tuple",
        internalType: "struct DagVote",
        components: [
          {
            name: "id",
            type: "address",
            internalType: "address",
          },
          {
            name: "weight",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "dist",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "posInOther",
            type: "uint256",
            internalType: "uint256",
          },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "findRelDepth",
    inputs: [
      {
        name: "voter",
        type: "address",
        internalType: "address",
      },
      {
        name: "recipient",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "isLocal",
        type: "bool",
        internalType: "bool",
      },
      {
        name: "relDepth",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "findRelDepthInner",
    inputs: [
      {
        name: "voter",
        type: "address",
        internalType: "address",
      },
      {
        name: "recipient",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "isLocal",
        type: "bool",
        internalType: "bool",
      },
      {
        name: "sRelRootDiff",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "rRelRootDiff",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "findRelRoot",
    inputs: [
      {
        name: "voter",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "relRoot",
        type: "address",
        internalType: "address",
      },
      {
        name: "relDepth",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "findSentDagVote",
    inputs: [
      {
        name: "voter",
        type: "address",
        internalType: "address",
      },
      {
        name: "recipient",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "votable",
        type: "bool",
        internalType: "bool",
      },
      {
        name: "voted",
        type: "bool",
        internalType: "bool",
      },
      {
        name: "sDist",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "rDist",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "votePos",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "dagVote",
        type: "tuple",
        internalType: "struct DagVote",
        components: [
          {
            name: "id",
            type: "address",
            internalType: "address",
          },
          {
            name: "weight",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "dist",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "posInOther",
            type: "uint256",
            internalType: "uint256",
          },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "findSentDagVoteNew",
    inputs: [
      {
        name: "voter",
        type: "address",
        internalType: "address",
      },
      {
        name: "recipient",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "votable",
        type: "bool",
        internalType: "bool",
      },
      {
        name: "voted",
        type: "bool",
        internalType: "bool",
      },
      {
        name: "votePos",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "dagVote",
        type: "tuple",
        internalType: "struct DagVote",
        components: [
          {
            name: "id",
            type: "address",
            internalType: "address",
          },
          {
            name: "weight",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "dist",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "posInOther",
            type: "uint256",
            internalType: "uint256",
          },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "joinTree",
    inputs: [
      {
        name: "voter",
        type: "address",
        internalType: "address",
      },
      {
        name: "voterName",
        type: "string",
        internalType: "string",
      },
      {
        name: "recipient",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "joinTreeAsRoot",
    inputs: [
      {
        name: "voter",
        type: "address",
        internalType: "address",
      },
      {
        name: "voterName",
        type: "string",
        internalType: "string",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "leaveTree",
    inputs: [
      {
        name: "voter",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "lockTree",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "moveTreeVote",
    inputs: [
      {
        name: "voter",
        type: "address",
        internalType: "address",
      },
      {
        name: "recipient",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "name",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "string",
        internalType: "string",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "nameOf",
    inputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "",
        type: "string",
        internalType: "string",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "readDepth",
    inputs: [
      {
        name: "voter",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "readRecDagVote",
    inputs: [
      {
        name: "recipient",
        type: "address",
        internalType: "address",
      },
      {
        name: "votePos",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        internalType: "struct DagVote",
        components: [
          {
            name: "id",
            type: "address",
            internalType: "address",
          },
          {
            name: "weight",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "dist",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "posInOther",
            type: "uint256",
            internalType: "uint256",
          },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "readSentDagVote",
    inputs: [
      {
        name: "voter",
        type: "address",
        internalType: "address",
      },
      {
        name: "votePos",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        internalType: "struct DagVote",
        components: [
          {
            name: "id",
            type: "address",
            internalType: "address",
          },
          {
            name: "weight",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "dist",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "posInOther",
            type: "uint256",
            internalType: "uint256",
          },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "recDagVote",
    inputs: [
      {
        name: "voter",
        type: "address",
        internalType: "address",
      },
      {
        name: "counter",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "id",
        type: "address",
        internalType: "address",
      },
      {
        name: "weight",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "dist",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "posInOther",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "recDagVoteCount",
    inputs: [
      {
        name: "voter",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "count",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "recTreeVote",
    inputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "recTreeVoteCount",
    inputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "removeDagVote",
    inputs: [
      {
        name: "voter",
        type: "address",
        internalType: "address",
      },
      {
        name: "recipient",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "reputation",
    inputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "reputationEpoch",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "root",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "sentDagVote",
    inputs: [
      {
        name: "voter",
        type: "address",
        internalType: "address",
      },
      {
        name: "counter",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "id",
        type: "address",
        internalType: "address",
      },
      {
        name: "weight",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "dist",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "posInOther",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "sentDagVoteCount",
    inputs: [
      {
        name: "voter",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "count",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "sentDagVoteTotalWeight",
    inputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "sentTreeVote",
    inputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "switchPositionWithParent",
    inputs: [
      {
        name: "voter",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "symbol",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "string",
        internalType: "string",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "tokenName",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "string",
        internalType: "string",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "tokenSymbol",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "string",
        internalType: "string",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "unlocked",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "bool",
        internalType: "bool",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "AddDagVoteEvent",
    inputs: [
      {
        name: "voter",
        type: "address",
        indexed: false,
        internalType: "address",
      },
      {
        name: "recipient",
        type: "address",
        indexed: false,
        internalType: "address",
      },
      {
        name: "weight",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ChangeNameEvent",
    inputs: [
      {
        name: "voter",
        type: "address",
        indexed: false,
        internalType: "address",
      },
      {
        name: "newName",
        type: "string",
        indexed: false,
        internalType: "string",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "JoinTreeEvent",
    inputs: [
      {
        name: "voter",
        type: "address",
        indexed: false,
        internalType: "address",
      },
      {
        name: "name",
        type: "string",
        indexed: false,
        internalType: "string",
      },
      {
        name: "recipient",
        type: "address",
        indexed: false,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "LeaveTreeEvent",
    inputs: [
      {
        name: "voter",
        type: "address",
        indexed: false,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "MoveTreeVoteEvent",
    inputs: [
      {
        name: "voter",
        type: "address",
        indexed: false,
        internalType: "address",
      },
      {
        name: "recipient",
        type: "address",
        indexed: false,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "RemoveDagVoteEvent",
    inputs: [
      {
        name: "voter",
        type: "address",
        indexed: false,
        internalType: "address",
      },
      {
        name: "recipient",
        type: "address",
        indexed: false,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "SwitchPositionWithParentEvent",
    inputs: [
      {
        name: "voter",
        type: "address",
        indexed: false,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
] as const;
