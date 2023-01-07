import express from "express";
// import Quote from 'inspirational-quotes';


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
    res.send({"id":anthillRootId});
});

app.get("/anthillGraphNum", function(req, res) {
    console.log("getting anthillGraphNum")
    res.send({"anthillGraphNum": anthillGraphNum});
});   

app.get("/id/:id", function(req, res) {
    console.log("getting id: ", req.params.id)
    res.send({"nodeData":anthillGraph[req.params.id]});
});

app.get("/bareId/:id", function(req, res) {
    console.log("getting bare id: ", req.params.id)
    var nodeData = anthillGraph[req.params.id]
    
    res.send({"nodeData":nodeData as NodeDataBare});
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


//////////////////////

// web3
var Web3 = require('web3');
const anvilUrl = "ws://localhost:8545";
var web3 = new Web3(anvilUrl);

// contract
const anthillContractAddress = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
var fs = require('fs');
var jsonFile = "../anthill/out/Anthill.sol/Anthill.json"
var contract= JSON.parse(fs.readFileSync(jsonFile));
var AnthillContract = new web3.eth.Contract(contract.abi, anthillContractAddress);


// types
type GraphData= {[id: string]: NodeData;}
export type NodeData = {"id":string, "name":string, "totalWeight":number; "onchainRep":number, "currentRep": number, "depth":number,  "relRoot":string,  "sentTreeVote": string, "recTreeVotes":string[], "sentDagVotes":DagVote[], "recDagVotes": DagVote[]}

export type NodeDataBare = {"id":string, "name":string,  "totalWeight":number; "onchainRep":number, "currentRep": number, "depth":number, "relRoot":string, "sentTreeVote": string,}

type DagVote = {'id': string, 'weight': number, 'otherPos': number}


var anthillGraph = {} as GraphData;
var anthillGraphByDepth = [[]] as string[][];
var maxDepth = 0;
var anthillGraphNum =0;
var maxRelRootDepth = 6;
var anthillRootId = "0x0000000000000000000000000000000000000000000000000000000000000000";

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

async function getSentDagVotes(id : string) : Promise<DagVote[]>{
    var dagVotes= [];
    
    var sentDagVoteCountString="" ;


    for (var i = 0; i < maxRelRootDepth; i++) {
        sentDagVoteCountString  = await AnthillContract.methods.readSentDagVoteCount(id, i).call();
        for (var j= 0; j< parseInt(sentDagVoteCountString); j++){
            var sDagVote = await AnthillContract.methods.readSentDagVote(id, i, j).call();
            /// the problem is here
            dagVotes.push(sDagVote);
        }
    }
    return dagVotes;
}

async function getRecDagVotes(id : string) : Promise<DagVote[]>{
    
    var dagVotes= [];
    var recDagVoteCountString="" ;


    for (var i = 0; i < maxRelRootDepth; i++) {
        recDagVoteCountString  = await AnthillContract.methods.readRecDagVoteCount(id, i).call();
        for (var j= 0; j< parseInt(recDagVoteCountString); j++){
            var rDagVote = await AnthillContract.methods.readRecDagVote(id, i, j).call();
            dagVotes.push(rDagVote);
        }
    }
    return dagVotes;
}

async function getSaveChildren(id: string){
    var childCount  = await AnthillContract.methods.readRecTreeVoteCount(id).call();
    for (var i = 0; i < childCount; i++) {
        var childId = await AnthillContract.methods.readRecTreeVote(id, i).call();

        var sentDagVotes: DagVote[]= await getSentDagVotes(childId);
        var recDagVotes: DagVote[]= await getRecDagVotes(childId);
        var onChainRep = await getAnthillReputation(childId);
        var name = await getAnthillName(childId);
        var totalWeight = await getAnthillTotalWeight(childId);

        var childNode = {"id": childId, "name":name,"totalWeight":totalWeight, "onchainRep":onChainRep, "currentRep": 0, "depth":0, "relRoot": "",  "sentTreeVote": id, "recTreeVotes": [], "sentDagVotes": sentDagVotes, "recDagVotes": recDagVotes} as NodeData;
        anthillGraph[childId] = childNode;

        // we push the children here instead of in the childnode initialisation above, as we are already crawling the tree. 
        console.log("did we push for "+ id +" the child  " + childId)
        anthillGraph[id].recTreeVotes.push(childId);

        await getSaveChildren(childId);
    }
    
}

async function loadAnthillGraph(){
    anthillGraph = {} as GraphData;
    anthillGraphNum +=1;

    var id : string= await getAnthillRootId();
    console.log("the root is: " + id )
    anthillRootId=id;
    var onChainRep = await getAnthillReputation(id);
    var name = await getAnthillName(id);
    var sentTreeVote = await AnthillContract.methods.readSentTreeVote(id).call();


    var node = {"id": id, "name": name, "totalWeight":0, "onchainRep":onChainRep, "currentRep": 0, "depth":0, "relRoot": "", "sentTreeVote": sentTreeVote ,  "recTreeVotes": [], "sentDagVotes": [],"recDagVotes":[]} as NodeData;
    anthillGraph[id] = node;

    await getSaveChildren(id);
}

async function crawlEthereum() {

    await loadAnthillGraph()

    calculateDepthAndRelRoot();
    calculateReputation();
   

    // start subscription
    var subscription = web3.eth.subscribe('logs', {"address": anthillContractAddress},
         function(error:any, result:any){ 
            if (!error){
                loadAnthillGraph();
            } else {console.log("we had some error in the eth subscription!", error)}
        }
    )
}


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

            node.recDagVotes.forEach((rDagVote) => {
                var voter = anthillGraph[rDagVote.id]
                node.currentRep += rDagVote.weight* voter.currentRep/voter.totalWeight;
            });
        });
    }
}