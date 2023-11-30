import { Tabs, TabList, TabPanels, Tab, TabPanel, Box } from "@chakra-ui/react";

function App() {
  const selectStyle = {
    color: "white",
    bg: "#333",
  };
  return (
    <Box
      style={{
        width: "100%",
        // height: "100vh",
        paddingTop: 20,
      }}
      minH={800}
    >
      <Tabs variant="unstyled">
        <TabList
          defaultValue={"ComfyUI"}
          style={{ marginBottom: 20, marginLeft: 16 }}
          gap={4}
        >
          <Tab _selected={selectStyle}>Workspace</Tab>
          <Tab _selected={selectStyle}>ComfyUI</Tab>
          <Tab _selected={selectStyle}>WebUI</Tab>
          <Tab _selected={selectStyle}>Models</Tab>
        </TabList>
        <TabPanels>
          <TabPanel>
            <p>one!</p>
          </TabPanel>
          <TabPanel style={{ padding: 0 }}>
            <iframe
              src="/index.html"
              title="Comfy Page"
              style={{
                width: "100%",
                height: "90vh",
                // minHeight: "800px",
                border: "none",
              }}
            />
          </TabPanel>
        </TabPanels>
      </Tabs>
    </Box>
  );
}

export default App;
