import express from "express";
import assert from "assert";

// import Quote from 'inspirational-quotes';

import {GraphData, address0, NodeDataStore, DagVote, joinTree, changeName,  addDagVote, removeDagVote, leaveTree, switchPositionWithParent, moveTreeVote} from "./dagBase";
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
    // console.log("getting anthillGraphNum")
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
// const providerURL = "ws://localhost:8545";
const providerURL = "wss://polygon-testnet.blastapi.io/88fd2015-7a3d-4ea1-a72d-34144c92d931"

var web3 = new Web3(providerURL);

// contract

const anthillContractAddress = "0xb2218969ECF92a3085B8345665d65FCdFED9F981" // mumbai v3
// const anthillContractAddress = "0x7b7D7Ea1c6aBA7aa7de1DC8595A9e839B0ee58FB" // mumbai v2.
// const anthillContractAddress = "0xE2C8d9C92eAb868C6078C778f12f794858147947" // mumbai v.1

// const anthillContractAddress = "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512" // forge with lib
// const anthillContractAddress ="0x5fbdb2315678afecb367f032d93f642f64180aa3" // forge without lib
var fs = require('fs');
var jsonFile = "./Anthill.json"
var contract= JSON.parse(fs.readFileSync(jsonFile));
var AnthillContract = new web3.eth.Contract(contract.abi, anthillContractAddress);


// types
export type NodeData = {"id":string, "name":string, "totalWeight":number;  "currentRep": number, "depth":number,  "relRoot":string,  "sentTreeVote": string, "recTreeVotes":string[], "sentDagVotes":DagVote[], "recDagVotes": DagVote[]}

export type NodeDataBare = {"id":string, "name":string,  "totalWeight":number;  "currentRep": number, "depth":number, "relRoot":string, "sentTreeVote": string, "recTreeVotes": string []}

var anthillGraph = {} as GraphData;
var anthillGraphByDepth = [[]] as string[][];
var anthillGraphNum =0;
var maxRelRootDepth = 6;
var anthillRootId = address0;
var randomLeaf =    address0;

async function crawlEthereum() {
    console.log("loading graph (slowest part)")
    await loadAnthillGraph(anthillGraph, anthillGraphByDepth, anthillGraphNum, AnthillContract)
    console.log("calculating depth")
    calculateDepthAndRelRoot(anthillGraph, anthillGraphByDepth);
    console.log("calculating reputation")
    calculateReputation(anthillGraph, anthillGraphByDepth);
    console.log("finding random leaf")
    randomLeaf = findRandomLeaf(anthillGraph);
    console.log("the found random leaf is: ", randomLeaf)
    replaceServe();

    // start subscription
    web3.eth.subscribe('logs', {"address": anthillContractAddress},
         async function(error:any, result:any){ 
            if (!error){

                // for testing we copy 
                // var anthillGraphCopy = (JSON.parse(JSON.stringify(anthillGraph))) as GraphData;
                // var anthillGraphByDepthCopy = [[]] as string[][]; 

                // assert (deepEqual(anthillGraph, anthillGraphCopy))
                // console.log("copy sanity check passed")

                // anthillGraphCopy.dict["0x0000000000000000000000000000000000000004"].recDagVotes[0][1][0].posInOther= 7; 
                // assert (deepEqual(anthillGraph, anthillGraphCopy)==false)
                // console.log("copy sanity check 2 passed")

                if (result.topics[0] == web3.eth.abi.encodeEventSignature("joinTreeEvent(address,string,address)")){
                    var {'0' :voter, '1':name, '2': recipient} =web3.eth.abi.decodeParameters(['address', 'string', 'address'], result.data);
                    console.log("joinTreeEvent", voter, name, recipient)
                    joinTree(anthillGraph, voter, name, recipient);

                } else if (result.topics[0] == web3.eth.abi.encodeEventSignature("changeNameEvent(address,string)")){

                    var {'0' :voter, '1':newName} =web3.eth.abi.decodeParameters(['address', 'string'], result.data);
                    console.log("changeNameEvent", voter, newName)
                    changeName(anthillGraph, voter, newName);

                } else if (result.topics[0] == web3.eth.abi.encodeEventSignature("addDagVoteEvent(address,address,uint32)")){

                    var {'0' :voter, '1':recipient, '2': weight} =web3.eth.abi.decodeParameters(['address', 'address', 'uint32'], result.data);
                    console.log("addDagVoteEvent", voter, recipient, weight )
                    addDagVote(anthillGraph, voter, recipient, parseInt(weight));

                } else if (result.topics[0] == web3.eth.abi.encodeEventSignature("removeDagVoteEvent(address,address)")){

                    var {'0' :voter, '1':recipient}  =web3.eth.abi.decodeParameters(['address', 'address'], result.data);
                    console.log("removeDagVote", voter, recipient)
                    removeDagVote(anthillGraph, voter, recipient);

                } else if (result.topics[0] == web3.eth.abi.encodeEventSignature("leaveTreeEvent(address)")){

                    var {'0' :voter} =web3.eth.abi.decodeParameters(['address'], result.data);
                    console.log("leaveTreeEvent", voter)
                    leaveTree(anthillGraph, voter);

                } else if (result.topics[0] == web3.eth.abi.encodeEventSignature("switchPositionWithParentEvent(address)")){

                    var {'0' :voter} =web3.eth.abi.decodeParameters(['address',], result.data);
                    console.log("switchPositionWithParentEvent", voter)
                    switchPositionWithParent(anthillGraph, voter);

                } else if (result.topics[0] == web3.eth.abi.encodeEventSignature("moveTreeVoteEvent(address,address)")){

                    var {'0' :voter, '1': recipient} =web3.eth.abi.decodeParameters(['address', 'address'], result.data);
                    console.log("moveTreeVoteEvent", voter, recipient)
                    moveTreeVote(anthillGraph, voter, recipient);

                } 

                anthillGraphByDepth = [[]] as string[][];

                
                
                calculateDepthAndRelRoot(anthillGraph, anthillGraphByDepth);
                calculateReputation(anthillGraph, anthillGraphByDepth);
                
                // for testing
                // await loadAnthillGraph(anthillGraphCopy, anthillGraphByDepthCopy, anthillGraphNum, AnthillContract);

                // calculateDepthAndRelRoot(anthillGraphCopy, anthillGraphByDepthCopy);
                // calculateReputation(anthillGraphCopy, anthillGraphByDepthCopy);

                // console.log("asserting")

                // console.log( JSON.stringify(anthillGraph))
                // console.log( JSON.stringify(anthillGraphCopy))

                // assert (deepEqual(anthillGraph, anthillGraphCopy));
                // console.log("testing assert success")
                
                findRandomLeaf(anthillGraph);
                anthillGraphNum +=1;

                replaceServe();
            } else {console.log("we had some error in the eth subscription!", error)}
        }
    )
}

function deepEqual(x:any, y:any):boolean {
    const ok = Object.keys, tx = typeof x, ty = typeof y;
    return x && y && tx === 'object' && tx === ty ? (
      ok(x).length === ok(y).length &&
        ok(x).every(key => deepEqual(x[key], y[key]))
    ) : (x === y);
  }