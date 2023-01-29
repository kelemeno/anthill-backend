import express from "express";
// import Quote from 'inspirational-quotes';

import {GraphData, address0, NodeDataStore, DagVote} from "./dagBase";
import {calculateDepthAndRelRoot, calculateReputation, findRandomLeaf} from "./dagProcessing";
import {loadAnthillGraph} from "./dagLoading";

//////////////////////////////
////// serve 
const app = express();

app.use(function(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

app.use((err:any, req:any, res:any, next:any) => {
    res.locals.error = err.response.data;
    const status = err.status || 500;
    res.status(status);
    res.render('error');
});


app.get("/maxRelRootDepth", function(req, res) {
    console.log("getting max rel root");
    res.send({"maxRelRootDepth": maxRelRootDepth});
    
});

app.get("/rootId", function(req, res) {
    console.log("getting root")
    res.send({"id":anthillRootIdServe});
});

app.get("/isNodeInGraph/:id", function(req, res) {
    console.log("isNodeInGraph")
    if (anthillGraphServe.dict[req.params.id] === undefined){
        res.send({"isNodeInGraph": false});
    } else {
        res.send({"isNodeInGraph": true});
    }
    
});  

app.get("/anthillGraphNum", function(req, res) {
    console.log("getting anthillGraphNum")
    res.send({"anthillGraphNum": anthillGraphNumServe});
});   

app.get("/id/:id", function(req, res) {
    console.log("getting id: ", req.params.id)
    res.send({"nodeData":NodeDataStoreCollapse(anthillGraphServe.dict[req.params.id])});
});

app.get("/bareId/:id", function(req, res) {
    console.log("getting bare id: ", req.params.id)
    // console.log("displaying: ", anthillGraphServe[req.params.id])
    var nodeData = anthillGraphServe.dict[req.params.id]
    
    res.send({"nodeData":nodeData as NodeDataBare});
});

app.get("/randomLeaf", function(req, res) {
    console.log("getting random leaf")
    
    res.send({"randomLeaf":randomLeafServe});
});

let port = process.env.PORT;

if(port == null || port == "") {
 port = "5000";
}

app.listen(port, function() {
    console.log("Server started successfully");
    console.log("Crawling ethereum for data");
    crawlEthereum();
    console.log("Finished crawling ethereum for data");

});

var anthillGraphServe = {} as GraphData;
var anthillGraphNumServe =0;

var anthillRootIdServe = address0;
var randomLeafServe = address0;


function replaceServe(){

    anthillGraphServe = anthillGraph;
    anthillGraphNumServe = anthillGraphNum;
    anthillRootIdServe = anthillRootId;
    randomLeafServe = randomLeaf;
}

function NodeDataStoreCollapse(node:NodeDataStore): NodeData {
    var nodec = {} as NodeData;
    nodec.id = node.id;
    nodec.name = node.name;

    nodec.depth = node.depth;
    nodec.currentRep = node.currentRep;
    nodec.onchainRep = node.onchainRep;
    nodec.relRoot = node.relRoot;

    nodec.totalWeight = node.totalWeight;
    nodec.sentTreeVote = node.sentTreeVote;
    nodec.recTreeVotes = node.recTreeVotes;

    nodec.sentDagVotes = [] as DagVote[];
    nodec.recDagVotes = [] as DagVote[];

    node.recDagVotes.forEach((rDagVoteAA) => {
        rDagVoteAA.forEach((rDagVoteA) => {
            rDagVoteA.forEach((rDagVote) => {
                nodec.recDagVotes.push(rDagVote);
            })
        })
    });
    
    node.sentDagVotes.forEach((sDagVoteAA) => {
        sDagVoteAA.forEach((sDagVoteA) => {
            sDagVoteA.forEach((sDagVote) => {
                nodec.sentDagVotes.push(sDagVote);
            })
        })
    });

    return nodec
}


//////////////////////
///// Load 


// web3
var Web3 = require('web3');
// const providerUrl = "ws://localhost:8545";
const providerURL = "wss://polygon-testnet.blastapi.io/88fd2015-7a3d-4ea1-a72d-34144c92d931"
// "wss://polygon-mumbai.infura.io/v3/2f35e26bd5094d0e946f38ab603841ed"


// "https://rpc-mumbai.maticvigil.com/v1/0x62031Ba7be7C70c00D32ffB2DE46B51752642AD3";
var web3 = new Web3(providerURL);

// contract
const anthillContractAddress = "0x7b7D7Ea1c6aBA7aa7de1DC8595A9e839B0ee58FB" // mumbai v2. 
//  "0xE2C8d9C92eAb868C6078C778f12f794858147947" // mumbai
// const anthillContractAddress = "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512" // forge with lib
// "0x5fbdb2315678afecb367f032d93f642f64180aa3" // forge without lib
var fs = require('fs');
var jsonFile = "./Anthill.json"
var contract= JSON.parse(fs.readFileSync(jsonFile));
var AnthillContract = new web3.eth.Contract(contract.abi, anthillContractAddress);


// types
export type NodeData = {"id":string, "name":string, "totalWeight":number; "onchainRep":number, "currentRep": number, "depth":number,  "relRoot":string,  "sentTreeVote": string, "recTreeVotes":string[], "sentDagVotes":DagVote[], "recDagVotes": DagVote[]}

export type NodeDataBare = {"id":string, "name":string,  "totalWeight":number; "onchainRep":number, "currentRep": number, "depth":number, "relRoot":string, "sentTreeVote": string, "recTreeVotes": string []}

var anthillGraph = {} as GraphData;
var anthillGraphByDepth = [[]] as string[][];
var anthillGraphNum =0;
var maxRelRootDepth = 6;
var anthillRootId = address0;
var randomLeaf =    address0;

async function crawlEthereum() {
    await loadAnthillGraph(anthillGraph, anthillGraphByDepth, anthillGraphNum, AnthillContract)

    calculateDepthAndRelRoot(anthillGraph, anthillGraphByDepth);
    calculateReputation(anthillGraph, anthillGraphByDepth);
    findRandomLeaf(anthillGraph);
    replaceServe();

    // start subscription
    web3.eth.subscribe('logs', {"address": anthillContractAddress},
         async function(error:any, result:any){ 
            if (!error){
                
                await loadAnthillGraph(anthillGraph, anthillGraphByDepth, anthillGraphNum, AnthillContract);
                calculateDepthAndRelRoot(anthillGraph, anthillGraphByDepth);
                calculateReputation(anthillGraph, anthillGraphByDepth);
                findRandomLeaf(anthillGraph);

                replaceServe();
            } else {console.log("we had some error in the eth subscription!", error)}
        }
    )
}