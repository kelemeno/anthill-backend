import assert from "assert";
import express from "express";
// import Quote from 'inspirational-quotes';

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
    if (anthillGraphServe[req.params.id] === undefined){
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
    res.send({"nodeData":NodeDataStoreCollapse(anthillGraphServe[req.params.id])});
});

app.get("/bareId/:id", function(req, res) {
    console.log("getting bare id: ", req.params.id)
    // console.log("displaying: ", anthillGraphServe[req.params.id])
    var nodeData = anthillGraphServe[req.params.id]
    
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

    getAnthillMaxRelRootDepth();
});

var anthillGraphServe = {} as GraphData;
var anthillGraphNumServe =0;
const address0 = "0x0000000000000000000000000000000000000000";
const address1 = "0x0000000000000000000000000000000000000001";
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
export type DagVote = {'id': string, 'weight': number, 'posInOther': number}
export type NodeDataStore = {"id":string, "name":string, "totalWeight":number; "onchainRep":number, "currentRep": number, "depth":number,  "relRoot":string,  "sentTreeVote": string, "recTreeVotes":string[], "sentDagVotes":DagVote[][][], "recDagVotes": DagVote[][][]}

export type GraphData= { [id: string]: NodeDataStore}
export type NodeDataBare = {"id":string, "name":string,  "totalWeight":number; "onchainRep":number, "currentRep": number, "depth":number, "relRoot":string, "sentTreeVote": string, "recTreeVotes": string []}

var anthillGraph = {} as GraphData;
var anthillGraphByDepth = [[]] as string[][];
var maxDepth = 0;
var anthillGraphNum =0;
var maxRelRootDepth = 6;
var anthillRootId = address0;
var randomLeaf =    address0;



function resetIntermediate(){
    anthillGraph = {} as GraphData;
    anthillGraphByDepth = [[]] as string[][];
    maxDepth = 0;
    anthillRootId = address0;
}

async function getAnthillMaxRelRootDepth() {
    const res = await AnthillContract.methods.readMaxRelRootDepth().call();
    maxRelRootDepth = res;
}


async function getAnthillRootId() {
    const res = await AnthillContract.methods.readRoot().call();
    anthillRootId = res;
    return res;
}

async function getAnthillName(id: string):Promise<string> {
    const res = await AnthillContract.methods.readName(id).call();
    return res;
}

async function getAnthillReputation(id: string):Promise<number> {
    const res = await AnthillContract.methods.readReputation(id).call();
    return res;
}

async function getAnthillTotalWeight(id: string):Promise<number> {
    const res = await AnthillContract.methods.readSentDagVoteTotalWeight(id).call();
    return res;
}

function delay(ms: number) {
    return new Promise( resolve => setTimeout(resolve, ms) );
}
const timeout=40;

async function getSentDagVotes(id : string) : Promise<DagVote[][][]>{
    var dagVotes= [[[]]] as DagVote[][][]; ; 
    var sentDagVoteCountString="" ;

    for (var dist =0; dist < maxRelRootDepth; dist++){
        for (var depth = 0; depth < maxRelRootDepth; depth++) {
            await delay(timeout);
            sentDagVoteCountString  = await AnthillContract.methods.readSentDagVoteCount(id, dist, depth).call();
            for (var j= 0; j < parseInt(sentDagVoteCountString); j++){
                await delay(timeout);
                var sDagVote = await AnthillContract.methods.readSentDagVote(id, dist, depth, j).call();
                if (sDagVote.id == address0){
                    continue;
                }
                dagVotes[dist][depth].push({"id":sDagVote.id , "weight":sDagVote.weight, "posInOther":sDagVote.posInOther});
            
            }
        }
    }
    return dagVotes;
}

async function getRecDagVotes(id : string) : Promise<DagVote[][][]>{
    var dagVotes= [[[]]] as DagVote[][][];
    var recDagVoteCountString="" ;

    for (var dist = 0; dist < maxRelRootDepth; dist++) {
        for (var depth = 0; depth < maxRelRootDepth; depth++) {
            await delay(timeout);
            recDagVoteCountString  = await AnthillContract.methods.readRecDagVoteCount(id, dist, depth).call();
            for (var j= 0; j< parseInt(recDagVoteCountString); j++){
                await delay(timeout);
                var rDagVote = await AnthillContract.methods.readRecDagVote(id, dist, depth, j).call();
                if (rDagVote.id == address0){
                    continue;
                }
                dagVotes[dist][depth].push({"id":rDagVote.id , "weight":rDagVote.weight, "posInOther":rDagVote.posInOther});
            }
        }
    }
    return dagVotes;
}

async function getSaveChildren(id: string){
    var childCount  = await AnthillContract.methods.readRecTreeVoteCount(id).call();
    for (var i = 0; i < childCount; i++) {
        var childId = (await AnthillContract.methods.readRecTreeVote(id, i).call());

        var sentDagVotes: DagVote[][][]= await getSentDagVotes(childId);
        var recDagVotes: DagVote[][][]= await getRecDagVotes(childId);
        var onChainRep = await getAnthillReputation(childId);
        await delay(timeout);
        var name = await getAnthillName(childId);
        await delay(timeout);
        var totalWeight = await getAnthillTotalWeight(childId);

        var childNode = {"id": childId, "name":name,"totalWeight":totalWeight, "onchainRep":onChainRep, "currentRep": 0, "depth":0, "relRoot": "",  "sentTreeVote": id, "recTreeVotes": [], "sentDagVotes": sentDagVotes, "recDagVotes": recDagVotes} as NodeDataStore;
        anthillGraph[childId] = childNode;

        // we push the children here instead of in the childnode initialisation above, as we are already crawling the tree. 
        anthillGraph[id].recTreeVotes.push(childId);

        await getSaveChildren(childId);
    }
    
}

async function loadAnthillGraph(){
    resetIntermediate();

    anthillGraphNum +=1;

    var id : string= (await getAnthillRootId());
    anthillRootId=id;
    console.log("root is: " + id);
    var onChainRep = await getAnthillReputation(id);
    var name = await getAnthillName(id);
    var sentTreeVote = await AnthillContract.methods.readSentTreeVote(id).call();

    var recDagVotes: DagVote[][][]= await getRecDagVotes(id);
    var totalWeight = await getAnthillTotalWeight(id);

    var node = {"id": id, "name": name, "totalWeight":totalWeight, "onchainRep":onChainRep, "currentRep": 0, "depth":0, "relRoot": "", "sentTreeVote": sentTreeVote ,  "recTreeVotes": [], "sentDagVotes": [[[]]],"recDagVotes":recDagVotes} as NodeDataStore;
    anthillGraph[id] = node;

    await getSaveChildren(id);
}

async function crawlEthereum() {

    await loadAnthillGraph()

    calculateDepthAndRelRoot();
    calculateReputation();
    findRandomLeaf();
    replaceServe();

    // start subscription
    web3.eth.subscribe('logs', {"address": anthillContractAddress},
         async function(error:any, result:any){ 
            if (!error){
                
                await loadAnthillGraph();
                calculateDepthAndRelRoot();
                calculateReputation();
                findRandomLeaf();

                replaceServe();
            } else {console.log("we had some error in the eth subscription!", error)}
        }
    )
}

//////////////
///// Process 


function calculateDepthAndRelRoot(){
    var parentsArray = Array.apply(null, Array(5)).map(()=> {return anthillRootId})
    calculateDepthAndRelRootInner(anthillRootId, 0, parentsArray);

}

function calculateDepthAndRelRootInner(id:string, depth: number, parents: string[]){
    anthillGraph[id].depth = depth;
    anthillGraph[id].relRoot = parents[0];

    if (anthillGraphByDepth[depth] == undefined){
        anthillGraphByDepth[depth] = [];
    }
    anthillGraphByDepth[depth].push(id);
    if (maxDepth < depth) {
        maxDepth = depth;
    }
    anthillGraph[id].recTreeVotes.forEach((childId) => {
        var newParents = parents.slice(1);
        newParents.push(id);
        calculateDepthAndRelRootInner(childId, depth+1, newParents);
    });

}

function calculateReputation(){
  
    for (var i = maxDepth; i >= 0; i--) {
        anthillGraphByDepth[i].forEach((id) => {
            var node = anthillGraph[id];
            node.currentRep = 10**18;

            node.recDagVotes.forEach((rDagVoteAA) => {
                rDagVoteAA.forEach((rDagVoteA) => {
                    rDagVoteA.forEach((rDagVote) => {
                        var voter = anthillGraph[rDagVote.id]
                        node.currentRep += rDagVote.weight* voter.currentRep/voter.totalWeight;
                    })
                })
            })
        });
    }
}

function findRandomLeaf(){
    var nodeId = anthillRootId;
    // console.log("finding random leaf", nodeId, anthillGraph[nodeId], anthillGraph[nodeId].recTreeVotes)
    while (anthillGraph[nodeId].recTreeVotes.length == 2){
        var rand = Math.floor(Math.random() * 2);
        nodeId = anthillGraph[nodeId].recTreeVotes[rand];
    }
    randomLeaf = nodeId;
}

////////////////////////////

///////////////////
////// Update
function joinTree( voter:string, name: string, recipient: string){
    // todo sanitity check
    if( anthillGraph[voter] == undefined) {
        // error we need to reload the graph
    }

    anthillGraph[voter].sentTreeVote = recipient;
    anthillGraph[recipient].recTreeVotes.push(voter);

    anthillGraph[voter].name = name;
    anthillGraph[voter].id= voter;

    //this has its own event, so not needed.  
    //addDagVote(voter, recipient, 1);

    anthillGraphNum +=1;

}

function changeName(voter: string, newName: string){
    // todo a sanity check

    anthillGraph[voter].name = newName;

    anthillGraphNum +=1;
}

function addDagVote(voter: string, recipient: string, weight: number){
    // todo sanity check 
    var [,dist, depth] = findDistDepth(voter, recipient)
    combinedDagAppendSDist(voter, recipient, dist, depth, weight);
    anthillGraphNum +=1;

}

function removeDagVote(voter: string, recipient: string){
    // sanity check that we have the voter recipient 
    var [,dist, depth] = findDistDepth(voter, recipient)
    for (var count = 0; count<= anthillGraph[voter].sentDagVotes[dist][depth].length; count++){
        if (anthillGraph[voter].sentDagVotes[dist][depth][count].id == recipient){
            safeRemoveSentDagVoteDistDepthPos(voter, dist, depth, count);
            anthillGraphNum +=1;
            return; 
        }
    }
    // we did not find voter, we need to reload the graph.
}

function leaveTree(voter:string) {
    // remove dag connections
    anthillGraph[voter].sentDagVotes.forEach((sDagVoteAA, dist)=>{
        sDagVoteAA.forEach((sDagVoteA, depth)=>{
            sDagVoteA.forEach((sDagVote, count)=>{
                safeRemoveSentDagVoteDistDepthPos(voter, dist, depth, count);
            })
        })
    });

    anthillGraph[voter].recDagVotes.forEach((rDagVoteAA, dist)=>{
        rDagVoteAA.forEach((rDagVoteA, depth)=>{
            rDagVoteA.forEach((rDagVote, count)=>{
                safeRemoveRecDagVoteDistDepthPos(voter, dist, depth, count);
            })
        })
    });

    handleLeavingVoterBranch(voter);
    delete anthillGraph[voter];
}

function switchPositionWithParent(voter:string){
    
    var parent = anthillGraph[voter].sentTreeVote;
    assert (parent != address0);
    assert (parent != address1);
    var gparent = anthillGraph[parent].sentTreeVote;
        
    handleDagVoteMove( parent, parent, voter, 0, 0);
    handleDagVoteMove( voter, gparent, parent, 2, 2);
    
    switchTreeVoteWithParent( voter);
}

function moveTreeVote(voter: string, recipient: string){
    (var relRoot, ) = AnthillInner.findRelRoot( dag , voter);
            (bool isLowerOrEqual, uint32 lowerSDist, uint32 lowerDepth) = AnthillInner.findSDistDepth( dag , recipient, voter);
            uint32 lowerRDist = lowerSDist - lowerDepth;
            (bool isSimilar, uint32 simDist, uint32 simDepth) = AnthillInner.findSDistDepth( dag , voter, recipient);
            (bool isHigher, uint32 higherRDist, uint32 higherDepthToRelRoot) = AnthillInner.findSDistDepth( dag , recipient, relRoot);
            uint32 higherDepth = dag.MAX_REL_ROOT_DEPTH - higherDepthToRelRoot;
            uint32 higherDist = higherRDist + higherDepth;

            // we need to leave the tree nowm so that our descendants can rise. 
            address parent= dag.treeVote[voter];
            AnthillInner.handleLeavingVoterBranch( dag , voter);

            if ((lowerRDist == 0) && (isLowerOrEqual)){
                // if we are jumping to our descendant who just rose, we have to modify the lowerSDist
                if (  AnthillInner.findNthParent( dag , recipient, lowerDepth)==parent){
                    lowerSDist = lowerSDist - 1;
                    lowerDepth = lowerDepth - 1;
                }
            }

            // currently we don't support position swithces here, so replaced address is always 0. 
            
                handleDagVoteMove(  voter, recipient, address(0), dist, depth);
           
            // handle tree votes
            // there is a single twise here, if recipient the descendant of the voter that rises.
            AnthillInner.addTreeVote( dag , voter, recipient);
}

/////////////
////// treeVotes
function removeTreeVote(voter: string){
    var parent = anthillGraph[voter].sentTreeVote;
    anthillGraph[voter].sentTreeVote=address1;
    anthillGraph[parent].recTreeVotes.forEach((childId, index) => {
        if (childId == voter) {
            anthillGraph[parent].recTreeVotes[index]=anthillGraph[parent].recTreeVotes[anthillGraph[parent].recTreeVotes.length-1];
            anthillGraph[parent].recTreeVotes.pop();
            return;
        }
    })
    // there was an error, panic. 
}

function addTreeVote(voter:string, recipient:string){
    anthillGraph[voter].sentTreeVote = recipient;
    anthillGraph[recipient].recTreeVotes.push(voter);
}

function switchTreeVoteWithParent( voter : string)  {
    var parent = anthillGraph[voter].sentTreeVote;
    assert(parent != address0);
    assert(parent != address1);
    
    var gparent = anthillGraph[parent].sentTreeVote; // this can be 1. 

    removeTreeVote(voter);
    
    if (anthillRootId== parent){
        anthillRootId= voter;
    } else {
        removeTreeVote(parent);
    }

    var brother = anthillGraph[parent].recTreeVotes[0] ;

    var child1 = anthillGraph[voter].recTreeVotes[0] ;
    var child2 = anthillGraph[voter].recTreeVotes[0] ;
    
    addTreeVote( voter, gparent);
    addTreeVote( parent, voter);

    if (brother != address0) {
        removeTreeVote(brother);
        addTreeVote( brother, voter);
    }

    if (child1 != address0) {
        removeTreeVote(child1);
        addTreeVote( child1, parent);
    }

    if (child2 != address0) {
        removeTreeVote(child2);
        addTreeVote( child2, parent);
    }
}


function pullUpBranch(pulledVoter: string, parent: string){
    var firstChild = anthillGraph[pulledVoter].recTreeVotes[0];
    var secondChild = anthillGraph[pulledVoter].recTreeVotes[1];

    if (firstChild!=address0){
        handleDagVoteMove( firstChild, parent, pulledVoter, 2, 2);
    
        pullUpBranch( firstChild, pulledVoter);    

        if (secondChild != address0){
            removeTreeVote( secondChild);
            addTreeVote(  secondChild, firstChild);
        }
    }
}

function handleLeavingVoterBranch(voter: string){
    var parent = anthillGraph[voter].sentTreeVote;

    var firstChild = anthillGraph[voter].recTreeVotes[0];
    var secondChild = anthillGraph[voter].recTreeVotes[1];

    if (firstChild!=address0){
        
        handleDagVoteMove( firstChild, parent, voter, 2, 2);

        pullUpBranch(  firstChild, voter);

        if (secondChild != address0){
            removeTreeVote( secondChild);
            addTreeVote( secondChild, firstChild);
        }

        removeTreeVote(  firstChild);
        addTreeVote( firstChild, parent);
    }

    removeTreeVote(  voter);
    anthillGraph[voter].sentTreeVote = address1;

    if (anthillRootId == voter ){
        anthillRootId = firstChild;
    }
}

///////////////////
////// DagVotes
function handleDagVoteMove(voter: string, recipient: string, replaced: string, moveDist: number, heightToRec:number){
    collapseSquareIntoColumn(voter, moveDist);
    moveSquareAlongDiagonal(voter, heightToRec-1);
    sortSquareColumn(voter, moveDist-heightToRec+1, recipient);
    if (replaced != address0) {
        sortSquareColumnDescendants(voter, replaced);
    }
}

function collapseSquareIntoColumn(voter: string, moveDist: number){
    // for each column move it to the destination column
    for (var dist = 0; dist< moveDist; dist++){
        for (var depth = 1; depth <= dist; depth++){
            moveSentDagCell(voter, dist, depth, moveDist, depth);
        }

        for (var depth = 1; depth <= maxRelRootDepth- dist; depth++){
            moveRecDagCell(voter, dist, depth, moveDist, depth);
        }
    }
}

function moveSquareAlongDiagonal(voter: string, diff: number){
    // rising, square down, start from bottom left. 
    if (diff > 0){ 
        for (var dist = 0; dist <= maxRelRootDepth; dist ++){
            for (var height = 1; height <= dist; height++){
                moveSentDagCell(voter, dist, height, dist-diff, height-diff);
            }

            for (var depth = maxRelRootDepth - dist; 1 <= depth; depth--){
                moveRecDagCell(voter, dist, depth, dist - diff, depth + diff);
            }
        }
    }

    // falling, square up, start from top right. 
    if (diff < 0) {
        for (var dist = maxRelRootDepth; 0 <= dist ;dist --){
            for (var height = dist; 1<= height; height-- ){
                moveSentDagCell(voter, dist, height, dist+diff, height+diff);
            }

            for (var depth=1; depth <= maxRelRootDepth - dist; depth++){
                moveRecDagCell(voter, dist, depth, dist + diff, depth - diff);
            }
        }
    }
}

    function sortSquareColumn(voter: string, moveDist: number, recipient: string){
        // Todo 
        // sort sentDagVotes
        // calculate ancestor of recipient at each depth to find new distance quickly
        var recipientAns = recipient; 
        for (var depth = 1; depth <= moveDist; depth++){
            for (var count = anthillGraph[voter].sentDagVotes[moveDist][depth].length-1; 0<= count; count--){
                var sDagVote = anthillGraph[voter].sentDagVotes[moveDist][depth][count];
                var [,distFromAns ] = findDistAtSameDepth(sDagVote.id, recipientAns);
                if (distFromAns+depth != moveDist){
                    safeRemoveSentDagVoteDistDepthPos(voter, moveDist, depth, count);
                    combinedDagAppendSDist(voter, sDagVote.id, distFromAns+ depth, depth, sDagVote.weight);
                }
            }

        recipientAns = anthillGraph[recipientAns].sentTreeVote;
    }
    
    // sort recDagVotes
    for (var depth = 1; depth <= maxRelRootDepth - moveDist; depth++){
        for (var count = anthillGraph[voter].recDagVotes[moveDist][depth].length-1; 0<= count; count--){

            var rDagVote = anthillGraph[voter].recDagVotes[moveDist][depth][count];
            var [,sdist, ] = findDistDepth(anthillGraph[rDagVote.id].sentTreeVote, recipient);
            if (sdist+1-depth != moveDist){
                safeRemoveRecDagVoteDistDepthPos(voter, moveDist, depth, count);
                combinedDagAppendSDist(rDagVote.id, voter, sdist+1, depth, rDagVote.weight);
            }
        }
    }
}

function sortSquareColumnDescendants(voter: string, replaced: string){
    for (var depth = 1; depth <= maxRelRootDepth; depth++){
        for (var count =anthillGraph[voter].recDagVotes[1][depth].length; 0<= count; count++){
            var rDagVote = anthillGraph[voter].recDagVotes[1][depth][count];
            var anscestor = findNthParent(rDagVote.id, depth);
            if (anscestor != replaced){
                safeRemoveRecDagVoteDistDepthPos(voter, 1, depth, count);
                combinedDagAppendSDist(rDagVote.id, voter, depth, depth, rDagVote.weight);
            }
        }
    }
}

// we could add this for efficiency, but we remove it for simplicity. The boundary checks in MoveCell make it redundant
    // function removeRecDagVoteBelowDepthInclusive(recipient: string, depth: number){
    //     for (var dist = 0; dist <= maxRelRootDepth; dist++){
    //         for (var d = maxRelRootDepth - dist; depth <= d; d--){
    //             for (var count = anthillGraph[recipient].recDagVotes[dist][d].length-1; 0<= count; count--){
    //                 safeRemoveRecDagVoteDistDepthPos(recipient, dist, d, count);                    
    //             }
    //         }
    //     }   
    // }

function moveSentDagCell(voter: string, sdist: number, height: number, newDist: number, newHeight: number){
    for (var count= anthillGraph[voter].sentDagVotes[sdist][height].length-1; 0<= count; count--){
        var sDagVote = anthillGraph[voter].sentDagVotes[sdist][height][count];
        
        safeRemoveSentDagVoteDistDepthPos(voter, sdist, height, count);
        if ((newHeight<= newDist) && (newHeight>= 1) && (newDist<= maxRelRootDepth)) {
            combinedDagAppendSDist(voter, sDagVote.id, newDist, newHeight, sDagVote.weight);
        }
    }
}

function moveRecDagCell(recipient: string, rdist: number, depth: number, newDist: number, newDepth: number){    
    for (var count= anthillGraph[recipient].recDagVotes[rdist][depth].length-1; 0<= count; count--){
        var rDagVote = anthillGraph[recipient].recDagVotes[rdist][depth][count];
        
        safeRemoveRecDagVoteDistDepthPos(recipient, rdist, depth, count);
        if ((newDepth<= maxRelRootDepth- newDist) && (newDepth>= 1) && (newDist>= 0)) {
            combinedDagAppendSDist(rDagVote.id, recipient, newDist+newDepth, newDepth, rDagVote.weight);
        }
    }
}

///////////////////


function unsafeReplaceSentDagVoteAtDistDepthPosWithLast(voter: string, sdist: number, depth: number, sPos: number){
    // find the vote we delete
    var sDagVote = anthillGraph[voter].sentDagVotes[sdist][depth][sPos];      
    anthillGraph[voter].totalWeight -= sDagVote.weight;

    if (sPos!= anthillGraph[voter].sentDagVotes[sdist][depth].length-1) {
        // if we delete a vote in the middle, we need to copy the last vote to the deleted position
        var copiedSentDagVote = anthillGraph[ voter].sentDagVotes[sdist][depth][ anthillGraph[voter].sentDagVotes[sdist][depth].length-1];
        anthillGraph[voter].sentDagVotes[sdist][depth][ sPos]= copiedSentDagVote;
        anthillGraph[copiedSentDagVote.id].recDagVotes[sdist-depth][depth][copiedSentDagVote.posInOther].posInOther = sPos;
    }
    
    // delete the potentially copied hence duplicate last vote
    anthillGraph[voter].sentDagVotes[sdist][depth].pop();
}

function unsafeReplaceRecDagVoteAtDistDepthPosWithLast(recipient: string, rdist: number, depth: number, rPos: number){
    if (rPos!= anthillGraph[recipient].recDagVotes[rdist][depth].length-1) {
        // if we delete a vote in the middle, we need to copy the last vote to the deleted position
        var copiedSentDagVote = anthillGraph[recipient].recDagVotes[rdist][depth][anthillGraph[recipient].recDagVotes[rdist][depth].length-1];
        anthillGraph[recipient].recDagVotes[rdist][depth][ rPos]= copiedSentDagVote;
        anthillGraph[copiedSentDagVote.id].sentDagVotes[rdist+depth][depth][copiedSentDagVote.posInOther].posInOther = rPos;
    }
    
    // delete the potentially copied hence duplicate last vote
    anthillGraph[recipient].recDagVotes[rdist][depth].pop();
}

function safeRemoveSentDagVoteDistDepthPos(voter: string, sdist: number, depth: number, sPos: number){
    var sDagVote = anthillGraph[voter].sentDagVotes[sdist][depth][sPos];
    unsafeReplaceSentDagVoteAtDistDepthPosWithLast(voter, sdist, depth, sPos);
    // delete the opposite
    unsafeReplaceRecDagVoteAtDistDepthPosWithLast( sDagVote.id, sdist-depth, depth, sDagVote.posInOther);
}

function safeRemoveRecDagVoteDistDepthPos(recipient: string, rdist: number, depth: number, rPos: number){
    var rDagVote = anthillGraph[recipient].recDagVotes[rdist][depth][rPos];
    unsafeReplaceRecDagVoteAtDistDepthPosWithLast( recipient, rdist, depth, rPos);
    // delete the opposite
    unsafeReplaceSentDagVoteAtDistDepthPosWithLast( rDagVote.id, rdist+depth, depth, rDagVote.posInOther);
}

function combinedDagAppendSDist(voter: string, recipient: string, dist: number, depth: number, weight: number){
    var sLen = anthillGraph[voter].sentDagVotes[dist][depth].length;
    var rLen = anthillGraph[recipient].recDagVotes[dist][depth].length;
    anthillGraph[voter].sentDagVotes[dist][depth].push({id: recipient, weight: weight, posInOther: rLen});
    anthillGraph[voter].totalWeight += weight;
    anthillGraph[recipient].recDagVotes[dist][depth].push({id: voter, weight: weight, posInOther: sLen});
}


/////////////

function findDistDepth(voter: string, recipient: string):[boolean, number, number]{
    var depthDiff = anthillGraph[recipient].depth- anthillGraph[voter].depth;
    var anscestor = findNthParent(voter, depthDiff);
    var [sameDepth, dist] = findDistAtSameDepth(anscestor, recipient);
    return [sameDepth, dist+depthDiff, depthDiff];
}

function findDistAtSameDepth(add1: string, add2: string):[boolean, number ]{
    if (add1 == add2){
        return [true, 0];
    }
    
    if ( anthillGraph[add1].sentTreeVote == address0 || anthillGraph[add2].sentTreeVote == address0) {
        return [false, 0];
    }        

    if (anthillGraph[add1].sentTreeVote == address1 || anthillGraph[add2].sentTreeVote == address1) {
        return [false, 0];
    }

    var [isSameDepth, distance] = findDistAtSameDepth( anthillGraph[add1].sentTreeVote, anthillGraph[add2].sentTreeVote);

    if (isSameDepth == true) {
        return [true, distance + 1];
    }

    return [false, 0];
}

function findNthParent(voter: string, height: number): string{
    if (height == 0) {
        return voter;
    }
    if (anthillGraph[voter].sentTreeVote == address1) {
        return address1;
    }

    // this should never be the case, but it is a safety check
    assert (anthillGraph[voter].sentTreeVote != address0);

    return findNthParent( anthillGraph[voter].sentTreeVote, height-1);
}
